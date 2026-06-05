require('dotenv').config();
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');

const Anthropic = require('@anthropic-ai/sdk').default || require('@anthropic-ai/sdk');

const app = express();
const port = process.env.PORT || 3000;

// CORS — 允许App访问
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// ── IP 限流 ──
const RATE_LIMIT = {
  DAILY_MAX: 20,        // 每个IP每天最多20次生成（包括拍照识别）
  SUGGEST_MAX: 50,      // 食材推荐接口单独限流（轻量操作，放宽）
  WINDOW_MS: 24 * 60 * 60 * 1000,  // 24小时窗口
  CLEANUP_INTERVAL: 60 * 60 * 1000  // 每小时清理过期记录
};

const ipStore = new Map(); // { ip: { count, suggest_count, resetAt } }

function getClientIP(req) {
  // Render / 代理环境取真实IP
  return (
    req.headers['x-forwarded-for']?.split(',')[0].trim() ||
    req.headers['x-real-ip'] ||
    req.socket.remoteAddress ||
    'unknown'
  );
}

function checkRateLimit(req, res, type = 'generate') {
  const ip = getClientIP(req);
  const now = Date.now();
  let record = ipStore.get(ip);

  // 初始化或窗口已过期 → 重置
  if (!record || now > record.resetAt) {
    record = { count: 0, suggestCount: 0, resetAt: now + RATE_LIMIT.WINDOW_MS };
    ipStore.set(ip, record);
  }

  if (type === 'suggest') {
    if (record.suggestCount >= RATE_LIMIT.SUGGEST_MAX) {
      const resetIn = Math.ceil((record.resetAt - now) / 1000 / 60);
      res.status(429).json({
        success: false,
        error: 'rate_limit',
        message: `Too many requests. Resets in ${resetIn} minutes.`,
        resetIn
      });
      return false;
    }
    record.suggestCount++;
  } else {
    if (record.count >= RATE_LIMIT.DAILY_MAX) {
      const resetIn = Math.ceil((record.resetAt - now) / 1000 / 60);
      res.status(429).json({
        success: false,
        error: 'rate_limit',
        message: `Daily limit reached (${RATE_LIMIT.DAILY_MAX} requests/day). Resets in ${resetIn} minutes.`,
        resetIn,
        limit: RATE_LIMIT.DAILY_MAX
      });
      return false;
    }
    record.count++;
  }

  ipStore.set(ip, record);
  return true;
}

// 定期清理过期记录，避免内存泄漏
setInterval(() => {
  const now = Date.now();
  let cleaned = 0;
  for (const [ip, record] of ipStore.entries()) {
    if (now > record.resetAt) { ipStore.delete(ip); cleaned++; }
  }
  if (cleaned > 0) console.log(`[rate-limit] Cleaned ${cleaned} expired records. Active IPs: ${ipStore.size}`);
}, RATE_LIMIT.CLEANUP_INTERVAL);

// 查看当前限流状态（可选，方便调试）
app.get('/api/status', (req, res) => {
  const ip = getClientIP(req);
  const record = ipStore.get(ip);
  const now = Date.now();
  if (!record || now > record.resetAt) {
    return res.json({ ip, used: 0, limit: RATE_LIMIT.DAILY_MAX, remaining: RATE_LIMIT.DAILY_MAX });
  }
  res.json({
    ip,
    used: record.count,
    limit: RATE_LIMIT.DAILY_MAX,
    remaining: Math.max(0, RATE_LIMIT.DAILY_MAX - record.count),
    resetsIn: Math.ceil((record.resetAt - now) / 1000 / 60) + ' minutes'
  });
});

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'uploads/'),
  filename: (req, file, cb) => cb(null, Date.now() + '-' + Math.random().toString(36).slice(2) + path.extname(file.originalname))
});
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
    allowed.includes(file.mimetype) ? cb(null, true) : cb(new Error('Image format not supported'));
  }
});

// 自动创建uploads目录
if (!fs.existsSync('uploads')) fs.mkdirSync('uploads');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = 'claude-haiku-4-5-20251001';
const SUPPORTED_LANGS = ['zh', 'en', 'fr', 'es'];

// ── 识别+生成一体化 Prompt ──
function buildDetectAndGeneratePrompt(lang, opts = {}) {
  const servings = opts.servings || '1-2';
  const dietary = opts.dietary || [];
  const style = opts.style || '';
  const condiments = opts.condiments && opts.condiments.length > 0 ? opts.condiments : null;

  // 饮食限制 — 强化措辞，明确冲突处理规则
  const dietaryRules = {
    zh: {
      vegetarian: '【强制素食】所有菜谱必须不含任何肉类（猪牛羊鸡鸭鱼虾等）。如果食材中有肉类，这些食材必须直接忽略，不得出现在任何菜谱中。',
      lowCal:     '【强制低卡】每道菜热量必须≤300卡，少油少糖少淀粉。',
      noSpicy:    '【强制不辣】所有菜谱和步骤中绝对不能使用辣椒、花椒、辣酱等任何辛辣调料。如果食材中有辣椒，必须忽略该食材。',
      noSeafood:  '【强制无海鲜】所有菜谱不含鱼虾蟹贝等海鲜。如果食材中有海鲜，必须忽略。',
      noNuts:     '【强制无坚果】所有菜谱不含花生、腰果、核桃等坚果。如果食材中有坚果，必须忽略。'
    },
    en: {
      vegetarian: '[MANDATORY VEGETARIAN] All recipes must contain zero meat (no pork, beef, chicken, fish, shrimp, etc.). If any meat appears in the ingredients, IGNORE it completely — do not use it in any recipe.',
      lowCal:     '[MANDATORY LOW-CAL] Every dish must be ≤300 calories. Use minimal oil and sugar.',
      noSpicy:    '[MANDATORY NO SPICY] Absolutely no chili, pepper, or any spicy ingredients in any recipe or step. If chili appears in ingredients, IGNORE it.',
      noSeafood:  '[MANDATORY NO SEAFOOD] No fish, shrimp, crab or shellfish. Ignore any seafood in ingredients.',
      noNuts:     '[MANDATORY NO NUTS] No peanuts, cashews, walnuts or any nuts. Ignore any nuts in ingredients.'
    },
    fr: {
      vegetarian: '[VÉGÉTARIEN OBLIGATOIRE] Aucune viande dans aucune recette. Ignorer toute viande dans les ingrédients.',
      lowCal:     '[BASSES CALORIES OBLIGATOIRE] Chaque plat ≤300 cal.',
      noSpicy:    '[NON ÉPICÉ OBLIGATOIRE] Aucun piment ni épice forte. Ignorer les piments dans les ingrédients.',
      noSeafood:  '[SANS FRUITS DE MER OBLIGATOIRE] Ignorer tous les fruits de mer.',
      noNuts:     '[SANS NOIX OBLIGATOIRE] Ignorer tous les fruits à coque.'
    },
    es: {
      vegetarian: '[VEGETARIANO OBLIGATORIO] Ninguna carne en ninguna receta. Ignorar cualquier carne en los ingredientes.',
      lowCal:     '[BAJAS CALORÍAS OBLIGATORIO] Cada plato ≤300 calorías.',
      noSpicy:    '[SIN PICANTE OBLIGATORIO] Ningún chile ni especia picante. Ignorar chiles en los ingredientes.',
      noSeafood:  '[SIN MARISCOS OBLIGATORIO] Ignorar todos los mariscos.',
      noNuts:     '[SIN FRUTOS SECOS OBLIGATORIO] Ignorar todos los frutos secos.'
    }
  };

  const styleNames = {
    zh: { stirFry:'炒菜', soup:'汤/煲', steam:'蒸菜', cold:'凉拌', noodle:'面食', any:'' },
    en: { stirFry:'Stir-fry', soup:'Soup/Stew', steam:'Steamed', cold:'Salad', noodle:'Noodles', any:'' },
    fr: { stirFry:'Sauté', soup:'Soupe', steam:'Vapeur', cold:'Salade', noodle:'Pâtes', any:'' },
    es: { stirFry:'Salteado', soup:'Sopa', steam:'Vapor', cold:'Ensalada', noodle:'Fideos', any:'' }
  };

  const ld = dietaryRules[lang] || dietaryRules.zh;
  const ls = styleNames[lang] || styleNames.zh;
  const dietLines = dietary.filter(d => ld[d]).map(d => ld[d]);
  const styleLine = style && ls[style] ? ls[style] : '';

  const condimentRule = {
    zh: condiments
      ? `【调料限制】只能使用以下调料，其他调料一律不得出现在步骤中：${condiments.join('、')}`
      : '基础调料（盐、油、酱油、醋、葱姜蒜）可用',
    en: condiments
      ? `[CONDIMENT RESTRICTION] Only use these condiments — no others: ${condiments.join(', ')}`
      : 'Basic condiments (salt, oil, soy sauce, vinegar, garlic) available',
    fr: condiments
      ? `[RESTRICTION CONDIMENTS] Utiliser uniquement : ${condiments.join(', ')}`
      : 'Condiments de base disponibles',
    es: condiments
      ? `[RESTRICCIÓN CONDIMENTOS] Solo usar: ${condiments.join(', ')}`
      : 'Condimentos básicos disponibles'
  };

  const prompts = {
    zh: `请仔细观察图片，识别所有可见食材。

然后根据食材推荐3道${servings}人份菜谱。

${dietLines.length ? '⚠️ 以下限制优先级最高，必须严格遵守，食材和限制冲突时以限制为准：
' + dietLines.map(r=>'• '+r).join('
') + '

' : ''}规则：
1. 只使用图片食材
2. 去除语义重复（番茄=西红柿）
3. 3道风格不同，每道≤30分钟
4. 估算卡路里和时间（纯数字）
5. ${condimentRule.zh}
6. 步骤里只能用已列出的食材和允许的调料，不能凭空添加其他材料
${styleLine ? '7. 烹饪偏好：' + styleLine + '（至少1道）' : ''}

JSON回复（search_query为B站/YouTube搜索词）：
{"ingredients":["食材1","食材2"],"recipes":[{"name":"菜名","time_min":15,"difficulty":"简单","calories":250,"ingredients":["食材1"],"steps":["步骤1","步骤2","步骤3","步骤4","步骤5"],"tip":"技巧","search_query":"菜名 做法"},{"name":"菜名","time_min":20,"difficulty":"中等","calories":300,"ingredients":["食材1"],"steps":["步骤1","步骤2","步骤3"],"tip":"技巧","search_query":"菜名 做法"},{"name":"菜名","time_min":25,"difficulty":"简单","calories":200,"ingredients":["食材1"],"steps":["步骤1","步骤2","步骤3"],"tip":"技巧","search_query":"菜名 做法"}]}`,

    en: `Carefully look at the image and identify all visible ingredients.
Suggest 3 recipes for ${servings} people.

${dietLines.length ? '⚠️ HIGHEST PRIORITY — MANDATORY RESTRICTIONS (override ingredient list):
' + dietLines.map(r=>'• '+r).join('
') + '

' : ''}Rules:
1. Only use visible ingredients
2. Deduplicate synonyms
3. 3 different styles, each ≤30 min
4. Estimate calories and time (pure numbers)
5. ${condimentRule.en}
6. Steps must only use listed ingredients and allowed condiments
${styleLine ? '7. Style preference: ' + styleLine + ' (at least 1)' : ''}

JSON (search_query = YouTube search keyword):
{"ingredients":["ing1","ing2"],"recipes":[{"name":"Name","time_min":15,"difficulty":"Easy","calories":250,"ingredients":["ing1"],"steps":["Step 1","Step 2","Step 3","Step 4","Step 5"],"tip":"Tip","search_query":"Name recipe"},{"name":"Name","time_min":20,"difficulty":"Medium","calories":300,"ingredients":["ing1"],"steps":["Step 1","Step 2","Step 3"],"tip":"Tip","search_query":"Name recipe"},{"name":"Name","time_min":25,"difficulty":"Easy","calories":200,"ingredients":["ing1"],"steps":["Step 1","Step 2","Step 3"],"tip":"Tip","search_query":"Name recipe"}]}`,

    fr: `Observez l'image et identifiez les ingrédients.
3 recettes pour ${servings} personnes.

${dietLines.length ? '⚠️ RESTRICTIONS OBLIGATOIRES (priorité maximale):
' + dietLines.map(r=>'• '+r).join('
') + '

' : ''}Règles: ingrédients visibles, pas de doublons, styles variés, ≤30min, estimer calories/temps.
${condimentRule.fr}
${styleLine ? 'Style : ' + styleLine : ''}

JSON (search_query = mot-clé YouTube):
{"ingredients":["ing1"],"recipes":[{"name":"Nom","time_min":15,"difficulty":"Facile","calories":250,"ingredients":["ing1"],"steps":["Étape 1","Étape 2","Étape 3"],"tip":"Conseil","search_query":"Nom recette"},{"name":"Nom","time_min":20,"difficulty":"Moyen","calories":300,"ingredients":["ing1"],"steps":["Étape 1","Étape 2","Étape 3"],"tip":"Conseil","search_query":"Nom recette"},{"name":"Nom","time_min":25,"difficulty":"Facile","calories":200,"ingredients":["ing1"],"steps":["Étape 1","Étape 2","Étape 3"],"tip":"Conseil","search_query":"Nom recette"}]}`,

    es: `Observe la imagen e identifique los ingredientes.
3 recetas para ${servings} personas.

${dietLines.length ? '⚠️ RESTRICCIONES OBLIGATORIAS (prioridad máxima):
' + dietLines.map(r=>'• '+r).join('
') + '

' : ''}Reglas: solo ingredientes visibles, sin duplicados, estilos variados, ≤30min, estimar calorías/tiempo.
${condimentRule.es}
${styleLine ? 'Estilo: ' + styleLine : ''}

JSON (search_query = búsqueda YouTube):
{"ingredients":["ing1"],"recipes":[{"name":"Nombre","time_min":15,"difficulty":"Fácil","calories":250,"ingredients":["ing1"],"steps":["Paso 1","Paso 2","Paso 3"],"tip":"Consejo","search_query":"Nombre receta"},{"name":"Nombre","time_min":20,"difficulty":"Medio","calories":300,"ingredients":["ing1"],"steps":["Paso 1","Paso 2","Paso 3"],"tip":"Consejo","search_query":"Nombre receta"},{"name":"Nombre","time_min":25,"difficulty":"Fácil","calories":200,"ingredients":["ing1"],"steps":["Paso 1","Paso 2","Paso 3"],"tip":"Consejo","search_query":"Nombre receta"}]}`
  };
  return prompts[lang] || prompts.zh;
}


function buildTextGeneratePrompt(ingredients, lang, opts = {}) {
  const servings = opts.servings || '1-2';
  const dietary = opts.dietary || [];
  const style = opts.style || '';
  const condiments = opts.condiments && opts.condiments.length > 0 ? opts.condiments : null;

  const dietaryRules = {
    zh: {
      vegetarian: '【强制素食】不含任何肉类。食材列表中有肉类的必须忽略，不得出现在任何菜谱中。',
      lowCal:     '【强制低卡】每道菜≤300卡，少油少糖。',
      noSpicy:    '【强制不辣】绝对不能使用辣椒、花椒等辛辣调料。食材中有辣椒必须忽略。',
      noSeafood:  '【强制无海鲜】不含鱼虾蟹贝。食材中有海鲜必须忽略。',
      noNuts:     '【强制无坚果】不含花生腰果等坚果。食材中有坚果必须忽略。'
    },
    en: {
      vegetarian: '[MANDATORY VEGETARIAN] No meat whatsoever. Ignore any meat ingredients.',
      lowCal:     '[MANDATORY LOW-CAL] Every dish ≤300 cal. Minimal oil/sugar.',
      noSpicy:    '[MANDATORY NO SPICY] No chili or spicy ingredients. Ignore any chili in the list.',
      noSeafood:  '[MANDATORY NO SEAFOOD] No fish/shrimp/shellfish. Ignore any seafood.',
      noNuts:     '[MANDATORY NO NUTS] No nuts of any kind. Ignore any nuts.'
    },
    fr: {
      vegetarian: '[VÉGÉTARIEN OBLIGATOIRE] Aucune viande. Ignorer la viande.',
      lowCal:     '[BASSES CALORIES OBLIGATOIRE] ≤300 cal par plat.',
      noSpicy:    '[NON ÉPICÉ OBLIGATOIRE] Aucun piment. Ignorer les piments.',
      noSeafood:  '[SANS FRUITS DE MER OBLIGATOIRE] Ignorer les fruits de mer.',
      noNuts:     '[SANS NOIX OBLIGATOIRE] Ignorer les noix.'
    },
    es: {
      vegetarian: '[VEGETARIANO OBLIGATORIO] Sin carne. Ignorar carnes.',
      lowCal:     '[BAJAS CALORÍAS OBLIGATORIO] ≤300 cal por plato.',
      noSpicy:    '[SIN PICANTE OBLIGATORIO] Sin chile. Ignorar chiles.',
      noSeafood:  '[SIN MARISCOS OBLIGATORIO] Ignorar mariscos.',
      noNuts:     '[SIN FRUTOS SECOS OBLIGATORIO] Ignorar frutos secos.'
    }
  };

  const styleNames = {
    zh: { stirFry:'炒菜', soup:'汤/煲', steam:'蒸菜', cold:'凉拌', noodle:'面食', any:'' },
    en: { stirFry:'Stir-fry', soup:'Soup', steam:'Steamed', cold:'Salad', noodle:'Noodles', any:'' },
    fr: { stirFry:'Sauté', soup:'Soupe', steam:'Vapeur', cold:'Salade', noodle:'Pâtes', any:'' },
    es: { stirFry:'Salteado', soup:'Sopa', steam:'Vapor', cold:'Ensalada', noodle:'Fideos', any:'' }
  };

  const ld = dietaryRules[lang] || dietaryRules.zh;
  const ls = styleNames[lang] || styleNames.zh;
  const dietLines = dietary.filter(d => ld[d]).map(d => ld[d]);
  const styleLine = style && ls[style] ? ls[style] : '';

  const condimentRule = {
    zh: condiments
      ? `【调料限制】步骤中只能使用这些调料，其他调料一律禁止：${condiments.join('、')}`
      : '基础调料（盐、油、酱油、醋、葱姜蒜）可用',
    en: condiments
      ? `[CONDIMENT RESTRICTION] Only these condiments allowed in steps — nothing else: ${condiments.join(', ')}`
      : 'Basic condiments (salt, oil, soy sauce, vinegar, garlic) available',
    fr: condiments
      ? `[RESTRICTION CONDIMENTS] Uniquement : ${condiments.join(', ')}`
      : 'Condiments de base disponibles',
    es: condiments
      ? `[RESTRICCIÓN CONDIMENTOS] Solo: ${condiments.join(', ')}`
      : 'Condimentos básicos disponibles'
  };

  const jsonFmt = {
    zh: '{"recipes":[{"name":"菜名","time_min":15,"difficulty":"简单/中等/较难","calories":250,"ingredients":["食材"],"steps":["步骤1","步骤2"],"tip":"技巧","search_query":"菜名 做法"},{"name":"菜名","time_min":20,"difficulty":"中等","calories":300,"ingredients":["食材"],"steps":["步骤1","步骤2"],"tip":"技巧","search_query":"菜名 做法"},{"name":"菜名","time_min":25,"difficulty":"简单","calories":200,"ingredients":["食材"],"steps":["步骤1","步骤2"],"tip":"技巧","search_query":"菜名 做法"}]}',
    en: '{"recipes":[{"name":"Name","time_min":15,"difficulty":"Easy/Medium/Hard","calories":250,"ingredients":["ing"],"steps":["Step 1","Step 2"],"tip":"Tip","search_query":"Name recipe"},{"name":"Name","time_min":20,"difficulty":"Medium","calories":300,"ingredients":["ing"],"steps":["Step 1","Step 2"],"tip":"Tip","search_query":"Name recipe"},{"name":"Name","time_min":25,"difficulty":"Easy","calories":200,"ingredients":["ing"],"steps":["Step 1","Step 2"],"tip":"Tip","search_query":"Name recipe"}]}',
    fr: '{"recipes":[{"name":"Nom","time_min":15,"difficulty":"Facile/Moyen/Difficile","calories":250,"ingredients":["ing"],"steps":["Étape 1","Étape 2"],"tip":"Conseil","search_query":"Nom recette"},{"name":"Nom","time_min":20,"difficulty":"Moyen","calories":300,"ingredients":["ing"],"steps":["Étape 1","Étape 2"],"tip":"Conseil","search_query":"Nom recette"},{"name":"Nom","time_min":25,"difficulty":"Facile","calories":200,"ingredients":["ing"],"steps":["Étape 1","Étape 2"],"tip":"Conseil","search_query":"Nom recette"}]}',
    es: '{"recipes":[{"name":"Nombre","time_min":15,"difficulty":"Fácil/Medio/Difícil","calories":250,"ingredients":["ing"],"steps":["Paso 1","Paso 2"],"tip":"Consejo","search_query":"Nombre receta"},{"name":"Nombre","time_min":20,"difficulty":"Medio","calories":300,"ingredients":["ing"],"steps":["Paso 1","Paso 2"],"tip":"Consejo","search_query":"Nombre receta"},{"name":"Nombre","time_min":25,"difficulty":"Fácil","calories":200,"ingredients":["ing"],"steps":["Paso 1","Paso 2"],"tip":"Consejo","search_query":"Nombre receta"}]}'
  };

  const prompts = {
    zh: `食材：${ingredients.join('、')}
${dietLines.length ? '
⚠️ 饮食限制（优先级最高，与食材冲突时以限制为准）：
' + dietLines.map(r=>'• '+r).join('
') + '
' : ''}
规则：推荐3道${servings}人份菜谱，每道≤30分钟，风格不同。卡路里和时间为纯数字。
${condimentRule.zh}
步骤里只能用已列出食材和上述允许的调料，不得额外添加。
${styleLine ? '烹饪偏好：' + styleLine + '（至少1道）' : ''}
JSON：${jsonFmt.zh}`,

    en: `Ingredients: ${ingredients.join(', ')}
${dietLines.length ? '
⚠️ MANDATORY RESTRICTIONS (highest priority, override ingredients):
' + dietLines.map(r=>'• '+r).join('
') + '
' : ''}
Rules: 3 recipes for ${servings} people, ≤30min each, varied styles. Numbers only for calories/time.
${condimentRule.en}
Steps must only use listed ingredients and allowed condiments.
${styleLine ? 'Style preference: ' + styleLine + ' (at least 1)' : ''}
JSON: ${jsonFmt.en}`,

    fr: `Ingrédients : ${ingredients.join(', ')}
${dietLines.length ? '
⚠️ RESTRICTIONS OBLIGATOIRES (priorité absolue):
' + dietLines.map(r=>'• '+r).join('
') + '
' : ''}
3 recettes ${servings} pers., ≤30min, styles variés. Nombres purs pour cal/temps.
${condimentRule.fr}${styleLine ? '
Style : ' + styleLine : ''}
JSON : ${jsonFmt.fr}`,

    es: `Ingredientes: ${ingredients.join(', ')}
${dietLines.length ? '
⚠️ RESTRICCIONES OBLIGATORIAS (máxima prioridad):
' + dietLines.map(r=>'• '+r).join('
') + '
' : ''}
3 recetas ${servings} pers., ≤30min, estilos variados. Números puros para cal/tiempo.
${condimentRule.es}${styleLine ? '
Estilo: ' + styleLine : ''}
JSON: ${jsonFmt.es}`
  };
  return prompts[lang] || prompts.zh;
}


function buildSuggestPrompt(ingredients, lang) {
  const prompts = {
    zh: `我有：${ingredients.join('、')}。推荐3-5个搭配食材（不重复已有的）。JSON：{"suggestions":["食材1","食材2"]}`,
    en: `I have: ${ingredients.join(', ')}. Suggest 3-5 pairing ingredients. JSON: {"suggestions":["ing1","ing2"]}`,
    fr: `J'ai : ${ingredients.join(', ')}. 3-5 suggestions. JSON : {"suggestions":["ing1","ing2"]}`,
    es: `Tengo: ${ingredients.join(', ')}. 3-5 sugerencias. JSON: {"suggestions":["ing1","ing2"]}`
  };
  return prompts[lang] || prompts.zh;
}

function parseJSON(text) {
  // 尝试从文本中提取JSON
  let clean = text.replace(/```json|```/g, '').trim();
  // 有时模型会在JSON前后加文字，尝试提取{}
  const match = clean.match(/\{[\s\S]*\}/);
  if (match) clean = match[0];
  return JSON.parse(clean);
}

// 接口1：拍照识别+生成（支持多图）
app.post('/detect-and-generate', upload.array('images', 5), async (req, res) => {
  try {
    if (!checkRateLimit(req, res, 'generate')) return;
    if (!req.files || req.files.length === 0) return res.json({ success: false, error: 'no_image' });
    const lang = SUPPORTED_LANGS.includes(req.body.lang) ? req.body.lang : 'zh';
    const opts = {
      servings: req.body.servings || '1-2',
      dietary: req.body.dietary ? JSON.parse(req.body.dietary) : [],
      style: req.body.style || '',
      condiments: req.body.condiments ? JSON.parse(req.body.condiments) : []
    };
    console.log(`[detect-and-generate] lang=${lang}, images=${req.files.length}`);

    // 构建多图内容
    const imageContent = req.files.map(file => ({
      type: 'image',
      source: {
        type: 'base64',
        media_type: file.mimetype,
        data: fs.readFileSync(file.path).toString('base64')
      }
    }));

    // 清理上传文件
    req.files.forEach(f => { try { fs.unlinkSync(f.path); } catch {} });

    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 3000,
      messages: [{
        role: 'user',
        content: [
          ...imageContent,
          { type: 'text', text: buildDetectAndGeneratePrompt(lang, opts) }
        ]
      }]
    });

    const text = response.content.map(c => c.text || '').join('');
    console.log('claude response:', text.substring(0, 200));
    const result = parseJSON(text);

    if (!result.ingredients || result.ingredients.length === 0) {
      return res.json({ success: false, error: 'no_ingredients' });
    }

    res.json({ success: true, data: result });

  } catch (err) {
    console.error('[detect-and-generate error]', err.message);
    // 清理文件
    if (req.files) req.files.forEach(f => { try { fs.unlinkSync(f.path); } catch {} });
    res.json({ success: false, error: 'detect_failed' });
  }
});

// 接口2：纯文本生成菜谱（手动输入 / 重新生成）
app.post('/generate', async (req, res) => {
  try {
    if (!checkRateLimit(req, res, 'generate')) return;
    const { ingredients, lang = 'zh', servings, dietary, style, condiments } = req.body;
    if (!ingredients || ingredients.length === 0) return res.json({ success: false, error: 'no_ingredients' });
    const safeLang = SUPPORTED_LANGS.includes(lang) ? lang : 'zh';

    console.log(`[generate] lang=${safeLang}, ingredients:`, ingredients);

    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 3000,
      messages: [{ role: 'user', content: buildTextGeneratePrompt(ingredients, safeLang, { servings, dietary, style }) }]
    });

    const text = response.content.map(c => c.text || '').join('');
    const result = parseJSON(text);
    res.json({ success: true, data: { ingredients, ...result } });

  } catch (err) {
    console.error('[generate error]', err.message);
    res.json({ success: false, error: 'generate_failed' });
  }
});

// 接口3：食材推荐
app.post('/suggest', async (req, res) => {
  try {
    if (!checkRateLimit(req, res, 'suggest')) return;
    const { ingredients, lang = 'zh' } = req.body;
    if (!ingredients || ingredients.length === 0) return res.json({ success: false, suggestions: [] });
    const safeLang = SUPPORTED_LANGS.includes(lang) ? lang : 'zh';

    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 200,
      messages: [{ role: 'user', content: buildSuggestPrompt(ingredients, safeLang) }]
    });

    const text = response.content.map(c => c.text || '').join('');
    const result = parseJSON(text);
    res.json({ success: true, suggestions: result.suggestions || [] });

  } catch (err) {
    console.error('[suggest error]', err.message);
    res.json({ success: false, suggestions: [] });
  }
});

app.listen(port, () => console.log(`✅ Server running at http://localhost:${port}`));
