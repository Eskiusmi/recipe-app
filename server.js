require('dotenv').config();
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk').default || require('@anthropic-ai/sdk');

const app = express();
const port = process.env.PORT || 3000;

// CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// ── Rate limiting ──
const RATE_LIMIT = {
  DAILY_MAX: 20,
  SUGGEST_MAX: 50,
  WINDOW_MS: 24 * 60 * 60 * 1000,
  CLEANUP_INTERVAL: 60 * 60 * 1000
};
const ipStore = new Map();

function getClientIP(req) {
  return (
    req.headers['x-forwarded-for']?.split(',')[0].trim() ||
    req.headers['x-real-ip'] ||
    req.socket.remoteAddress ||
    'unknown'
  );
}

function checkRateLimit(req, res, type) {
  const ip = getClientIP(req);
  const now = Date.now();
  let r = ipStore.get(ip);
  if (!r || now > r.resetAt) {
    r = { count: 0, suggestCount: 0, resetAt: now + RATE_LIMIT.WINDOW_MS };
    ipStore.set(ip, r);
  }
  if (type === 'suggest') {
    if (r.suggestCount >= RATE_LIMIT.SUGGEST_MAX) {
      const m = Math.ceil((r.resetAt - now) / 60000);
      res.status(429).json({ success: false, error: 'rate_limit', resetIn: m });
      return false;
    }
    r.suggestCount++;
  } else {
    if (r.count >= RATE_LIMIT.DAILY_MAX) {
      const m = Math.ceil((r.resetAt - now) / 60000);
      res.status(429).json({ success: false, error: 'rate_limit', resetIn: m, limit: RATE_LIMIT.DAILY_MAX });
      return false;
    }
    r.count++;
  }
  ipStore.set(ip, r);
  return true;
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, r] of ipStore.entries()) {
    if (now > r.resetAt) ipStore.delete(ip);
  }
}, RATE_LIMIT.CLEANUP_INTERVAL);

app.get('/api/status', (req, res) => {
  const ip = getClientIP(req);
  const r = ipStore.get(ip);
  const now = Date.now();
  if (!r || now > r.resetAt) return res.json({ ip, used: 0, limit: RATE_LIMIT.DAILY_MAX, remaining: RATE_LIMIT.DAILY_MAX });
  res.json({ ip, used: r.count, limit: RATE_LIMIT.DAILY_MAX, remaining: Math.max(0, RATE_LIMIT.DAILY_MAX - r.count), resetsIn: Math.ceil((r.resetAt - now) / 60000) + ' min' });
});

// uploads dir
if (!fs.existsSync('uploads')) fs.mkdirSync('uploads');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = 'claude-haiku-4-5-20251001';
const SUPPORTED_LANGS = ['zh', 'en', 'fr', 'es'];

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'uploads/'),
  filename: (req, file, cb) => cb(null, Date.now() + '-' + Math.random().toString(36).slice(2) + path.extname(file.originalname))
});
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    ['image/jpeg','image/png','image/webp','image/gif'].includes(file.mimetype) ? cb(null, true) : cb(new Error('Unsupported format'));
  }
});

// ── Dietary restriction labels (strict wording) ──
const DIETARY_RULES = {
  zh: {
    vegetarian: '[强制素食] 所有菜谱绝对不含任何肉类(猪牛羊鸡鸭鱼虾等)。食材中有肉类必须直接忽略，不得出现在任何菜谱步骤中。',
    lowCal:     '[强制低卡] 每道菜热量必须小于等于300卡，少油少糖少淀粉。',
    noSpicy:    '[强制不辣] 所有菜谱步骤中绝对不能使用辣椒、花椒、辣酱等辛辣调料。食材中有辣椒必须忽略该食材。',
    noSeafood:  '[强制无海鲜] 所有菜谱不含鱼虾蟹贝等海鲜。食材中有海鲜必须忽略。',
    noNuts:     '[强制无坚果] 所有菜谱不含花生腰果核桃等坚果。食材中有坚果必须忽略。'
  },
  en: {
    vegetarian: '[MANDATORY VEGETARIAN] Zero meat in all recipes (no pork, beef, chicken, fish, shrimp, etc.). If any meat is in the ingredient list, IGNORE it — do not use it anywhere.',
    lowCal:     '[MANDATORY LOW-CAL] Every dish must be 300 calories or less. Minimal oil and sugar.',
    noSpicy:    '[MANDATORY NO SPICY] Absolutely no chili, pepper flakes, or any spicy ingredients in any recipe or step. If chili is in the ingredients, IGNORE it.',
    noSeafood:  '[MANDATORY NO SEAFOOD] No fish, shrimp, crab, or shellfish. Ignore any seafood in the ingredient list.',
    noNuts:     '[MANDATORY NO NUTS] No peanuts, cashews, walnuts, or any nuts. Ignore any nuts in the ingredient list.'
  },
  fr: {
    vegetarian: '[VEGETARIEN OBLIGATOIRE] Aucune viande dans aucune recette. Ignorer toute viande dans les ingredients.',
    lowCal:     '[BASSES CALORIES OBLIGATOIRE] Chaque plat 300 cal maximum.',
    noSpicy:    '[NON EPICE OBLIGATOIRE] Aucun piment ni epice forte. Ignorer les piments dans les ingredients.',
    noSeafood:  '[SANS FRUITS DE MER OBLIGATOIRE] Ignorer tous les fruits de mer.',
    noNuts:     '[SANS NOIX OBLIGATOIRE] Ignorer tous les fruits a coque.'
  },
  es: {
    vegetarian: '[VEGETARIANO OBLIGATORIO] Sin carne en ninguna receta. Ignorar cualquier carne en los ingredientes.',
    lowCal:     '[BAJAS CALORIAS OBLIGATORIO] Cada plato maximo 300 calorias.',
    noSpicy:    '[SIN PICANTE OBLIGATORIO] Sin chile ni especias picantes. Ignorar chiles en los ingredientes.',
    noSeafood:  '[SIN MARISCOS OBLIGATORIO] Ignorar todos los mariscos.',
    noNuts:     '[SIN FRUTOS SECOS OBLIGATORIO] Ignorar todos los frutos secos.'
  }
};

const STYLE_NAMES = {
  zh: { stirFry:'炒菜', soup:'汤/煲', steam:'蒸菜', cold:'凉拌', noodle:'面食', any:'' },
  en: { stirFry:'Stir-fry', soup:'Soup/Stew', steam:'Steamed', cold:'Salad', noodle:'Noodles', any:'' },
  fr: { stirFry:'Saute', soup:'Soupe', steam:'Vapeur', cold:'Salade', noodle:'Pates', any:'' },
  es: { stirFry:'Salteado', soup:'Sopa', steam:'Vapor', cold:'Ensalada', noodle:'Fideos', any:'' }
};

function getDietLines(dietary, lang) {
  const rules = DIETARY_RULES[lang] || DIETARY_RULES.zh;
  return (dietary || []).filter(d => rules[d]).map(d => rules[d]);
}

function getStyleLine(style, lang) {
  const names = STYLE_NAMES[lang] || STYLE_NAMES.zh;
  return (style && names[style]) ? names[style] : '';
}

function getCondimentRule(condiments, lang) {
  if (condiments && condiments.length > 0) {
    const list = condiments.join(lang === 'zh' ? '、' : ', ');
    if (lang === 'zh') return '[调料限制] 步骤中只能使用以下调料，其他调料一律禁止：' + list;
    if (lang === 'fr') return '[RESTRICTION CONDIMENTS] Utiliser uniquement ces condiments : ' + list;
    if (lang === 'es') return '[RESTRICCION CONDIMENTOS] Solo estos condimentos : ' + list;
    return '[CONDIMENT RESTRICTION] Only these condiments allowed — nothing else: ' + list;
  }
  if (lang === 'zh') return '基础调料(盐、油、酱油、醋、葱姜蒜)可用';
  if (lang === 'fr') return 'Condiments de base disponibles (sel, huile, ail, vinaigre)';
  if (lang === 'es') return 'Condimentos basicos disponibles (sal, aceite, ajo, vinagre)';
  return 'Basic condiments available (salt, oil, soy sauce, vinegar, garlic)';
}

const JSON_FMT_DETECT = {
  zh: '{"ingredients":["食材1","食材2"],"recipes":[{"name":"菜名","time_min":15,"difficulty":"简单","calories":250,"ingredients":["食材1"],"steps":["步骤1","步骤2","步骤3","步骤4","步骤5"],"tip":"技巧","search_query":"菜名 做法"},{"name":"菜名","time_min":20,"difficulty":"中等","calories":300,"ingredients":["食材1"],"steps":["步骤1","步骤2","步骤3"],"tip":"技巧","search_query":"菜名 做法"},{"name":"菜名","time_min":25,"difficulty":"简单","calories":200,"ingredients":["食材1"],"steps":["步骤1","步骤2","步骤3"],"tip":"技巧","search_query":"菜名 做法"}]}',
  en: '{"ingredients":["ing1","ing2"],"recipes":[{"name":"Name","time_min":15,"difficulty":"Easy","calories":250,"ingredients":["ing1"],"steps":["Step 1","Step 2","Step 3","Step 4","Step 5"],"tip":"Tip","search_query":"Name recipe"},{"name":"Name","time_min":20,"difficulty":"Medium","calories":300,"ingredients":["ing1"],"steps":["Step 1","Step 2","Step 3"],"tip":"Tip","search_query":"Name recipe"},{"name":"Name","time_min":25,"difficulty":"Easy","calories":200,"ingredients":["ing1"],"steps":["Step 1","Step 2","Step 3"],"tip":"Tip","search_query":"Name recipe"}]}',
  fr: '{"ingredients":["ing1"],"recipes":[{"name":"Nom","time_min":15,"difficulty":"Facile","calories":250,"ingredients":["ing1"],"steps":["Etape 1","Etape 2","Etape 3"],"tip":"Conseil","search_query":"Nom recette"},{"name":"Nom","time_min":20,"difficulty":"Moyen","calories":300,"ingredients":["ing1"],"steps":["Etape 1","Etape 2","Etape 3"],"tip":"Conseil","search_query":"Nom recette"},{"name":"Nom","time_min":25,"difficulty":"Facile","calories":200,"ingredients":["ing1"],"steps":["Etape 1","Etape 2","Etape 3"],"tip":"Conseil","search_query":"Nom recette"}]}',
  es: '{"ingredients":["ing1"],"recipes":[{"name":"Nombre","time_min":15,"difficulty":"Facil","calories":250,"ingredients":["ing1"],"steps":["Paso 1","Paso 2","Paso 3"],"tip":"Consejo","search_query":"Nombre receta"},{"name":"Nombre","time_min":20,"difficulty":"Medio","calories":300,"ingredients":["ing1"],"steps":["Paso 1","Paso 2","Paso 3"],"tip":"Consejo","search_query":"Nombre receta"},{"name":"Nombre","time_min":25,"difficulty":"Facil","calories":200,"ingredients":["ing1"],"steps":["Paso 1","Paso 2","Paso 3"],"tip":"Consejo","search_query":"Nombre receta"}]}'
};

const JSON_FMT_TEXT = {
  zh: '{"recipes":[{"name":"菜名","time_min":15,"difficulty":"简单/中等/较难","calories":250,"ingredients":["食材"],"steps":["步骤1","步骤2"],"tip":"技巧","search_query":"菜名 做法"},{"name":"菜名","time_min":20,"difficulty":"中等","calories":300,"ingredients":["食材"],"steps":["步骤1","步骤2"],"tip":"技巧","search_query":"菜名 做法"},{"name":"菜名","time_min":25,"difficulty":"简单","calories":200,"ingredients":["食材"],"steps":["步骤1","步骤2"],"tip":"技巧","search_query":"菜名 做法"}]}',
  en: '{"recipes":[{"name":"Name","time_min":15,"difficulty":"Easy/Medium/Hard","calories":250,"ingredients":["ing"],"steps":["Step 1","Step 2"],"tip":"Tip","search_query":"Name recipe"},{"name":"Name","time_min":20,"difficulty":"Medium","calories":300,"ingredients":["ing"],"steps":["Step 1","Step 2"],"tip":"Tip","search_query":"Name recipe"},{"name":"Name","time_min":25,"difficulty":"Easy","calories":200,"ingredients":["ing"],"steps":["Step 1","Step 2"],"tip":"Tip","search_query":"Name recipe"}]}',
  fr: '{"recipes":[{"name":"Nom","time_min":15,"difficulty":"Facile/Moyen/Difficile","calories":250,"ingredients":["ing"],"steps":["Etape 1","Etape 2"],"tip":"Conseil","search_query":"Nom recette"},{"name":"Nom","time_min":20,"difficulty":"Moyen","calories":300,"ingredients":["ing"],"steps":["Etape 1","Etape 2"],"tip":"Conseil","search_query":"Nom recette"},{"name":"Nom","time_min":25,"difficulty":"Facile","calories":200,"ingredients":["ing"],"steps":["Etape 1","Etape 2"],"tip":"Conseil","search_query":"Nom recette"}]}',
  es: '{"recipes":[{"name":"Nombre","time_min":15,"difficulty":"Facil/Medio/Dificil","calories":250,"ingredients":["ing"],"steps":["Paso 1","Paso 2"],"tip":"Consejo","search_query":"Nombre receta"},{"name":"Nombre","time_min":20,"difficulty":"Medio","calories":300,"ingredients":["ing"],"steps":["Paso 1","Paso 2"],"tip":"Consejo","search_query":"Nombre receta"},{"name":"Nombre","time_min":25,"difficulty":"Facil","calories":200,"ingredients":["ing"],"steps":["Paso 1","Paso 2"],"tip":"Consejo","search_query":"Nombre receta"}]}'
};

// Build prompt as array of lines then join — avoids all nested quote issues
function buildDetectPrompt(lang, opts) {
  const servings = opts.servings || '1-2';
  const dietLines = getDietLines(opts.dietary, lang);
  const styleLine = getStyleLine(opts.style, lang);
  const condRule = getCondimentRule(opts.condiments, lang);
  const fmt = JSON_FMT_DETECT[lang] || JSON_FMT_DETECT.en;

  const lines = [];

  if (lang === 'zh') {
    lines.push('请仔细观察图片，识别所有可见食材，然后推荐3道' + servings + '人份菜谱。');
    if (dietLines.length) {
      lines.push('');
      lines.push('警告：以下饮食限制优先级最高，与食材冲突时以限制为准，被限制的食材必须完全忽略：');
      dietLines.forEach(r => lines.push(r));
      lines.push('');
    }
    lines.push('规则：');
    lines.push('1. 只使用图片中的食材');
    lines.push('2. 去除语义重复（番茄=西红柿只保留一个）');
    lines.push('3. 3道菜风格不同，每道30分钟内完成');
    lines.push('4. 卡路里和时间返回纯数字');
    lines.push('5. ' + condRule);
    lines.push('6. 步骤里只能用已列出的食材和允许的调料，不能额外添加');
    if (styleLine) lines.push('7. 烹饪偏好：' + styleLine + '（至少1道符合）');
    lines.push('');
    lines.push('严格按以下JSON回复，search_query为B站搜索关键词：');
    lines.push(fmt);
  } else if (lang === 'fr') {
    lines.push('Observez l image et identifiez les ingredients. Suggerez 3 recettes pour ' + servings + ' personnes.');
    if (dietLines.length) {
      lines.push('');
      lines.push('RESTRICTIONS OBLIGATOIRES - priorite absolue - ignorer les ingredients en conflit :');
      dietLines.forEach(r => lines.push(r));
      lines.push('');
    }
    lines.push('Regles : ingredients visibles uniquement, pas de doublons, styles varies, max 30min, estimer calories et temps en nombres purs.');
    lines.push(condRule);
    if (styleLine) lines.push('Style prefere : ' + styleLine + ' (au moins 1 plat)');
    lines.push('JSON strict, search_query = mot-cle YouTube :');
    lines.push(fmt);
  } else if (lang === 'es') {
    lines.push('Observe la imagen e identifique los ingredientes. Sugiera 3 recetas para ' + servings + ' personas.');
    if (dietLines.length) {
      lines.push('');
      lines.push('RESTRICCIONES OBLIGATORIAS - maxima prioridad - ignorar ingredientes en conflicto :');
      dietLines.forEach(r => lines.push(r));
      lines.push('');
    }
    lines.push('Reglas: solo ingredientes visibles, sin duplicados, estilos variados, max 30min, calorias y tiempo como numeros puros.');
    lines.push(condRule);
    if (styleLine) lines.push('Estilo preferido: ' + styleLine + ' (al menos 1 plato)');
    lines.push('JSON estricto, search_query = busqueda YouTube:');
    lines.push(fmt);
  } else {
    lines.push('Carefully look at the image and identify all visible ingredients. Suggest 3 recipes for ' + servings + ' people.');
    if (dietLines.length) {
      lines.push('');
      lines.push('WARNING: The following restrictions have HIGHEST PRIORITY. If an ingredient conflicts with a restriction, IGNORE that ingredient entirely:');
      dietLines.forEach(r => lines.push(r));
      lines.push('');
    }
    lines.push('Rules:');
    lines.push('1. Only use visible ingredients');
    lines.push('2. Deduplicate synonyms');
    lines.push('3. 3 different styles, each 30 min or less');
    lines.push('4. Calories and time as pure numbers');
    lines.push('5. ' + condRule);
    lines.push('6. Steps must only use listed ingredients and allowed condiments');
    if (styleLine) lines.push('7. Style preference: ' + styleLine + ' (at least 1 dish)');
    lines.push('');
    lines.push('Reply strictly in JSON, search_query = YouTube search keyword:');
    lines.push(fmt);
  }

  return lines.join('\n');
}

function buildTextPrompt(ingredients, lang, opts) {
  const servings = opts.servings || '1-2';
  const dietLines = getDietLines(opts.dietary, lang);
  const styleLine = getStyleLine(opts.style, lang);
  const condRule = getCondimentRule(opts.condiments, lang);
  const fmt = JSON_FMT_TEXT[lang] || JSON_FMT_TEXT.en;
  const ingList = lang === 'zh' ? ingredients.join('、') : ingredients.join(', ');

  const lines = [];

  if (lang === 'zh') {
    lines.push('食材：' + ingList);
    lines.push('推荐3道' + servings + '人份菜谱，每道30分钟内，风格不同。');
    if (dietLines.length) {
      lines.push('');
      lines.push('警告：以下饮食限制优先级最高，与食材冲突时以限制为准，被限制的食材必须完全忽略：');
      dietLines.forEach(r => lines.push(r));
      lines.push('');
    }
    lines.push(condRule);
    lines.push('步骤里只能用已列出食材和上述允许的调料，不得额外添加。');
    lines.push('卡路里和时间返回纯数字。');
    if (styleLine) lines.push('烹饪偏好：' + styleLine + '（至少1道）');
    lines.push('JSON：' + fmt);
  } else if (lang === 'fr') {
    lines.push('Ingredients : ' + ingList);
    lines.push('3 recettes pour ' + servings + ' personnes, max 30min, styles varies.');
    if (dietLines.length) {
      lines.push('RESTRICTIONS OBLIGATOIRES :');
      dietLines.forEach(r => lines.push(r));
    }
    lines.push(condRule);
    if (styleLine) lines.push('Style : ' + styleLine);
    lines.push('Calorias et temps en nombres purs. JSON : ' + fmt);
  } else if (lang === 'es') {
    lines.push('Ingredientes: ' + ingList);
    lines.push('3 recetas para ' + servings + ' personas, max 30min, estilos variados.');
    if (dietLines.length) {
      lines.push('RESTRICCIONES OBLIGATORIAS :');
      dietLines.forEach(r => lines.push(r));
    }
    lines.push(condRule);
    if (styleLine) lines.push('Estilo: ' + styleLine);
    lines.push('Calorias y tiempo como numeros puros. JSON: ' + fmt);
  } else {
    lines.push('Ingredients: ' + ingList);
    lines.push('Suggest 3 recipes for ' + servings + ' people, max 30min each, varied styles.');
    if (dietLines.length) {
      lines.push('WARNING: MANDATORY RESTRICTIONS — HIGHEST PRIORITY. Ignore conflicting ingredients:');
      dietLines.forEach(r => lines.push(r));
    }
    lines.push(condRule);
    lines.push('Steps must only use listed ingredients and allowed condiments. Calories and time as pure numbers.');
    if (styleLine) lines.push('Style preference: ' + styleLine + ' (at least 1)');
    lines.push('JSON: ' + fmt);
  }

  return lines.join('\n');
}

function buildSuggestPrompt(ingredients, lang) {
  const list = lang === 'zh' ? ingredients.join('、') : ingredients.join(', ');
  if (lang === 'zh') return '我有：' + list + '。推荐3-5个搭配食材（不重复已有的）。JSON：{"suggestions":["食材1","食材2"]}';
  if (lang === 'fr') return 'Ingredients : ' + list + '. Suggerer 3-5 ingredients complementaires. JSON : {"suggestions":["ing1","ing2"]}';
  if (lang === 'es') return 'Tengo: ' + list + '. Sugerir 3-5 ingredientes. JSON: {"suggestions":["ing1","ing2"]}';
  return 'I have: ' + list + '. Suggest 3-5 pairing ingredients. JSON: {"suggestions":["ing1","ing2"]}';
}

function parseJSON(text) {
  let clean = text.replace(/```json|```/g, '').trim();
  const match = clean.match(/\{[\s\S]*\}/);
  if (match) clean = match[0];
  return JSON.parse(clean);
}

// ── Routes ──
app.post('/detect-and-generate', upload.array('images', 5), async (req, res) => {
  try {
    if (!checkRateLimit(req, res, 'generate')) return;
    if (!req.files || !req.files.length) return res.json({ success: false, error: 'no_image' });

    const lang = SUPPORTED_LANGS.includes(req.body.lang) ? req.body.lang : 'zh';
    const opts = {
      servings: req.body.servings || '1-2',
      dietary: req.body.dietary ? JSON.parse(req.body.dietary) : [],
      style: req.body.style || '',
      condiments: req.body.condiments ? JSON.parse(req.body.condiments) : []
    };

    console.log('[detect-and-generate] lang=' + lang + ' images=' + req.files.length);

    const imageContent = req.files.map(f => ({
      type: 'image',
      source: { type: 'base64', media_type: f.mimetype, data: fs.readFileSync(f.path).toString('base64') }
    }));

    req.files.forEach(f => { try { fs.unlinkSync(f.path); } catch(e) {} });

    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 3000,
      messages: [{
        role: 'user',
        content: [...imageContent, { type: 'text', text: buildDetectPrompt(lang, opts) }]
      }]
    });

    const text = response.content.map(c => c.text || '').join('');
    const result = parseJSON(text);

    if (!result.ingredients || !result.ingredients.length) {
      return res.json({ success: false, error: 'no_ingredients' });
    }

    res.json({ success: true, data: result });

  } catch (err) {
    console.error('[detect-and-generate error]', err.message);
    if (req.files) req.files.forEach(f => { try { fs.unlinkSync(f.path); } catch(e) {} });
    res.json({ success: false, error: 'detect_failed' });
  }
});

app.post('/generate', async (req, res) => {
  try {
    if (!checkRateLimit(req, res, 'generate')) return;
    const { ingredients, lang = 'zh', servings, dietary, style, condiments } = req.body;
    if (!ingredients || !ingredients.length) return res.json({ success: false, error: 'no_ingredients' });

    const safeLang = SUPPORTED_LANGS.includes(lang) ? lang : 'zh';
    console.log('[generate] lang=' + safeLang);

    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 3000,
      messages: [{ role: 'user', content: buildTextPrompt(ingredients, safeLang, { servings, dietary, style, condiments }) }]
    });

    const text = response.content.map(c => c.text || '').join('');
    const result = parseJSON(text);
    res.json({ success: true, data: { ingredients, ...result } });

  } catch (err) {
    console.error('[generate error]', err.message);
    res.json({ success: false, error: 'generate_failed' });
  }
});

app.post('/suggest', async (req, res) => {
  try {
    if (!checkRateLimit(req, res, 'suggest')) return;
    const { ingredients, lang = 'zh' } = req.body;
    if (!ingredients || !ingredients.length) return res.json({ success: false, suggestions: [] });

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

app.listen(port, () => console.log('Server running on port ' + port));
