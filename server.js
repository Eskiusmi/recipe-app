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

app.use(express.static('public'));
app.use(express.json());

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'uploads/'),
  filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname))
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

  const dietaryRules = {
    zh: { vegetarian:'素食（不含肉类海鲜）', lowCal:'低卡（每道≤300卡）', noSpicy:'不辣', noSeafood:'无海鲜', noNuts:'无坚果' },
    en: { vegetarian:'Vegetarian (no meat/seafood)', lowCal:'Low-cal (≤300cal/dish)', noSpicy:'Not spicy', noSeafood:'No seafood', noNuts:'No nuts' },
    fr: { vegetarian:'Végétarien', lowCal:'Léger (≤300cal)', noSpicy:'Non épicé', noSeafood:'Sans fruits de mer', noNuts:'Sans noix' },
    es: { vegetarian:'Vegetariano', lowCal:'Bajo en calorías (≤300cal)', noSpicy:'Sin picante', noSeafood:'Sin mariscos', noNuts:'Sin frutos secos' }
  };
  const styleNames = {
    zh: { stirFry:'炒菜', soup:'汤/煲', steam:'蒸菜', cold:'凉拌', noodle:'面食', any:'' },
    en: { stirFry:'Stir-fry', soup:'Soup/Stew', steam:'Steamed', cold:'Salad', noodle:'Noodles', any:'' },
    fr: { stirFry:'Sauté', soup:'Soupe', steam:'Vapeur', cold:'Salade', noodle:'Pâtes', any:'' },
    es: { stirFry:'Salteado', soup:'Sopa', steam:'Vapor', cold:'Ensalada', noodle:'Fideos', any:'' }
  };

  const ld = dietaryRules[lang] || dietaryRules.zh;
  const ls = styleNames[lang] || styleNames.zh;
  const dietLines = dietary.filter(d => ld[d]).map(d => `- ${ld[d]}`);
  const styleLine = style && ls[style] ? ls[style] : '';

  const prompts = {
    zh: `请仔细观察这张图片，识别出所有可见的食材。

然后根据识别到的食材，推荐3道适合${servings}人份的菜谱。

规则：
1. 只使用图片中看到的食材（盐油酱醋葱姜蒜等基础调料默认有）
2. 去除语义重复（番茄=西红柿只保留一个）
3. 3道菜风格不同
4. 每道菜30分钟内完成
5. 估算每道菜的卡路里（返回纯数字，单位卡）
6. 估算每道菜的烹饪时间（返回纯数字，单位分钟）
7. 中文回复
${dietLines.length ? '8. 饮食限制：\n' + dietLines.join('\n') : ''}
${styleLine ? '烹饪偏好：' + styleLine + '（至少1道）' : ''}

严格按JSON回复，不要其他文字：
{"ingredients":["食材1","食材2"],"recipes":[{"name":"菜名","time_min":15,"difficulty":"简单","calories":250,"ingredients":["食材1"],"steps":["步骤1","步骤2","步骤3","步骤4","步骤5"],"tip":"技巧"},{"name":"菜名","time_min":20,"difficulty":"中等","calories":300,"ingredients":["食材1"],"steps":["步骤1","步骤2","步骤3"],"tip":"技巧"},{"name":"菜名","time_min":25,"difficulty":"简单","calories":200,"ingredients":["食材1"],"steps":["步骤1","步骤2","步骤3"],"tip":"技巧"}]}`,

    en: `Look at this image carefully and identify all visible ingredients.

Then suggest 3 recipes for ${servings} people using those ingredients.

Rules:
1. Only use visible ingredients (salt, oil, soy sauce, vinegar, garlic, ginger available)
2. Deduplicate synonyms
3. Vary styles
4. Each dish ≤30 min
5. Estimate calories per dish (pure number, in cal)
6. Estimate cooking time per dish (pure number, in minutes)
7. Reply in English
${dietLines.length ? '8. Dietary:\n' + dietLines.join('\n') : ''}
${styleLine ? 'Style preference: ' + styleLine + ' (at least 1)' : ''}

Reply strictly in JSON:
{"ingredients":["ing1","ing2"],"recipes":[{"name":"Name","time_min":15,"difficulty":"Easy","calories":250,"ingredients":["ing1"],"steps":["Step 1","Step 2","Step 3","Step 4","Step 5"],"tip":"Tip"},{"name":"Name","time_min":20,"difficulty":"Medium","calories":300,"ingredients":["ing1"],"steps":["Step 1","Step 2","Step 3"],"tip":"Tip"},{"name":"Name","time_min":25,"difficulty":"Easy","calories":200,"ingredients":["ing1"],"steps":["Step 1","Step 2","Step 3"],"tip":"Tip"}]}`,

    fr: `Observez cette image et identifiez tous les ingrédients visibles.

Suggérez 3 recettes pour ${servings} personnes.

Règles : 1. Uniquement ingrédients visibles 2. Dédupliquer 3. Varier styles 4. ≤30 min 5. Estimer calories (nombre pur) 6. Estimer temps (nombre pur, minutes) 7. En français
${dietLines.length ? '8. Régime :\n' + dietLines.join('\n') : ''}
${styleLine ? 'Style : ' + styleLine : ''}

JSON strict :
{"ingredients":["ing1"],"recipes":[{"name":"Nom","time_min":15,"difficulty":"Facile","calories":250,"ingredients":["ing1"],"steps":["Étape 1"],"tip":"Conseil"},{"name":"Nom","time_min":20,"difficulty":"Moyen","calories":300,"ingredients":["ing1"],"steps":["Étape 1"],"tip":"Conseil"},{"name":"Nom","time_min":25,"difficulty":"Facile","calories":200,"ingredients":["ing1"],"steps":["Étape 1"],"tip":"Conseil"}]}`,

    es: `Observe esta imagen e identifique todos los ingredientes visibles.

Sugiera 3 recetas para ${servings} personas.

Reglas: 1. Solo ingredientes visibles 2. Deduplicar 3. Variar estilos 4. ≤30 min 5. Estimar calorías (número puro) 6. Estimar tiempo (número puro, minutos) 7. En español
${dietLines.length ? '8. Dieta:\n' + dietLines.join('\n') : ''}
${styleLine ? 'Estilo: ' + styleLine : ''}

JSON estricto:
{"ingredients":["ing1"],"recipes":[{"name":"Nombre","time_min":15,"difficulty":"Fácil","calories":250,"ingredients":["ing1"],"steps":["Paso 1"],"tip":"Consejo"},{"name":"Nombre","time_min":20,"difficulty":"Medio","calories":300,"ingredients":["ing1"],"steps":["Paso 1"],"tip":"Consejo"},{"name":"Nombre","time_min":25,"difficulty":"Fácil","calories":200,"ingredients":["ing1"],"steps":["Paso 1"],"tip":"Consejo"}]}`
  };
  return prompts[lang] || prompts.zh;
}

function buildTextGeneratePrompt(ingredients, lang, opts = {}) {
  const servings = opts.servings || '1-2';
  const dietary = opts.dietary || [];
  const style = opts.style || '';

  const dietaryRules = {
    zh: { vegetarian:'素食', lowCal:'低卡（≤300卡）', noSpicy:'不辣', noSeafood:'无海鲜', noNuts:'无坚果' },
    en: { vegetarian:'Vegetarian', lowCal:'Low-cal (≤300cal)', noSpicy:'Not spicy', noSeafood:'No seafood', noNuts:'No nuts' },
    fr: { vegetarian:'Végétarien', lowCal:'Léger', noSpicy:'Non épicé', noSeafood:'Sans mer', noNuts:'Sans noix' },
    es: { vegetarian:'Vegetariano', lowCal:'Bajo calorías', noSpicy:'Sin picante', noSeafood:'Sin mariscos', noNuts:'Sin nueces' }
  };
  const styleNames = {
    zh: { stirFry:'炒菜', soup:'汤/煲', steam:'蒸菜', cold:'凉拌', noodle:'面食', any:'' },
    en: { stirFry:'Stir-fry', soup:'Soup', steam:'Steamed', cold:'Salad', noodle:'Noodles', any:'' },
    fr: { stirFry:'Sauté', soup:'Soupe', steam:'Vapeur', cold:'Salade', noodle:'Pâtes', any:'' },
    es: { stirFry:'Salteado', soup:'Sopa', steam:'Vapor', cold:'Ensalada', noodle:'Fideos', any:'' }
  };

  const ld = dietaryRules[lang] || dietaryRules.zh;
  const ls = styleNames[lang] || styleNames.zh;
  const dietLines = dietary.filter(d => ld[d]).map(d => `- ${ld[d]}`);
  const styleLine = style && ls[style] ? ls[style] : '';

  const prompts = {
    zh: `食材：${ingredients.join('、')}
推荐3道${servings}人份菜谱，30分钟内。盐油酱醋葱姜蒜默认有。3道风格不同。卡路里和时间返回纯数字。
${dietLines.length ? '限制：' + dietLines.join('，') : ''}${styleLine ? ' 偏好：' + styleLine : ''}
JSON：{"recipes":[{"name":"菜名","time_min":15,"difficulty":"简单/中等/较难","calories":250,"ingredients":["食材"],"steps":["步骤1","步骤2"],"tip":"技巧"},...]}`,

    en: `Ingredients: ${ingredients.join(', ')}
3 recipes for ${servings} people, ≤30min. Salt/oil/soy/garlic available. Vary styles. Calories and time as pure numbers.
${dietLines.length ? 'Dietary: ' + dietLines.join(', ') : ''}${styleLine ? ' Style: ' + styleLine : ''}
JSON: {"recipes":[{"name":"Name","time_min":15,"difficulty":"Easy/Medium/Hard","calories":250,"ingredients":["ing"],"steps":["Step 1"],"tip":"Tip"},...]}`,

    fr: `Ingrédients : ${ingredients.join(', ')}
3 recettes pour ${servings} pers., ≤30min. Sel/huile/ail disponibles. Varier. Calories et temps en nombres.
${dietLines.length ? 'Régime : ' + dietLines.join(', ') : ''}${styleLine ? ' Style : ' + styleLine : ''}
JSON : {"recipes":[{"name":"Nom","time_min":15,"difficulty":"Facile/Moyen/Difficile","calories":250,"ingredients":["ing"],"steps":["Étape"],"tip":"Conseil"},...]}`,

    es: `Ingredientes: ${ingredients.join(', ')}
3 recetas para ${servings} pers., ≤30min. Sal/aceite/ajo disponibles. Variar. Calorías y tiempo como números.
${dietLines.length ? 'Dieta: ' + dietLines.join(', ') : ''}${styleLine ? ' Estilo: ' + styleLine : ''}
JSON: {"recipes":[{"name":"Nombre","time_min":15,"difficulty":"Fácil/Medio/Difícil","calories":250,"ingredients":["ing"],"steps":["Paso"],"tip":"Consejo"},...]}`,
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

// 接口1：拍照识别+生成（一次Claude调用搞定）
app.post('/detect-and-generate', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.json({ success: false, error: 'no_image' });
    const lang = SUPPORTED_LANGS.includes(req.body.lang) ? req.body.lang : 'zh';
    const imagePath = req.file.path;
    const imageData = fs.readFileSync(imagePath).toString('base64');
    const mimeType = req.file.mimetype;

    const opts = {
      servings: req.body.servings || '1-2',
      dietary: req.body.dietary ? JSON.parse(req.body.dietary) : [],
      style: req.body.style || ''
    };

    console.log(`[detect-and-generate] lang=${lang}, servings=${opts.servings}`);

    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 3000,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mimeType, data: imageData } },
          { type: 'text', text: buildDetectAndGeneratePrompt(lang, opts) }
        ]
      }]
    });

    fs.unlinkSync(imagePath);

    const text = response.content.map(c => c.text || '').join('');
    console.log('claude response:', text.substring(0, 200));
    const result = parseJSON(text);

    if (!result.ingredients || result.ingredients.length === 0) {
      return res.json({ success: false, error: 'no_ingredients' });
    }

    res.json({ success: true, data: result });

  } catch (err) {
    console.error('[detect-and-generate error]', err.message);
    res.json({ success: false, error: 'detect_failed' });
  }
});

// 接口2：纯文本生成菜谱（手动输入 / 重新生成）
app.post('/generate', async (req, res) => {
  try {
    const { ingredients, lang = 'zh', servings, dietary, style } = req.body;
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