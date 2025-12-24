import { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } from "@google/generative-ai"

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "")

// Language character validation patterns - EXACT copy from working Vercel code
const LANGUAGE_PATTERNS = {
  ru: /[А-Яа-яЁё]/,
  ar: /[\u0600-\u06FF]/,
  zh: /[\u4E00-\u9FFF]/,
  ja: /[\u3040-\u309F\u30A0-\u30FF]/,
  ko: /[\uAC00-\uD7AF]/,
  he: /[\u0590-\u05FF]/,
  th: /[\u0E00-\u0E7F]/,
  hi: /[\u0900-\u097F]/,
  el: /[\u0370-\u03FF]/,
  vi: /[\u00C0-\u1EF9]/,
  // European languages use Latin characters
  es: /./,
  fr: /./,
  de: /./,
  pt: /./,
  it: /./,
  pl: /./,
  nl: /./,
  sv: /./,
  tr: /./,
}

// EXACT validation logic from working Vercel code
function isValidTranslation(html, language, originalHtml) {
  console.log(`[Railway] Validating translation for language: ${language}`)
  console.log(`[Railway] Original HTML length: ${originalHtml.length}, Translated HTML length: ${html.length}`)

  // Check 1: Has basic HTML structure (very lenient)
  const hasHTML = html.toLowerCase().includes("<html") && html.toLowerCase().includes("</html>")
  if (!hasHTML) {
    console.log(`[Railway] VALIDATION FAILED: Missing HTML structure`)
    console.log(`[Railway] First 500 chars: ${html.substring(0, 500)}`)
    console.log(`[Railway] Last 500 chars: ${html.substring(html.length - 500)}`)
    return false
  }
  console.log("[Railway] Check 1 PASSED: HTML structure present")

  // Check 2: Not empty
  if (html.length < 200) {
    console.log(`[Railway] VALIDATION FAILED: Translation too short (${html.length} characters)`)
    return false
  }
  console.log(`[Railway] Check 2 PASSED: Sufficient length (${html.length} chars)`)

  // Check 3: For non-Latin languages, check if target characters exist
  const strictLanguageCheck = ["ru", "ar", "zh", "ja", "ko", "he", "th", "hi", "el"]
  if (strictLanguageCheck.includes(language)) {
    const pattern = LANGUAGE_PATTERNS[language]
    if (pattern && !pattern.test(html)) {
      console.log(`[Railway] VALIDATION FAILED: No ${language} characters found in translation`)
      console.log(`[Railway] Sample of translation (chars 500-1000): ${html.substring(500, 1000)}`)
      return false
    }
    console.log(`[Railway] Check 3 PASSED: ${language.toUpperCase()} characters detected`)
  } else {
    console.log(`[Railway] Check 3 SKIPPED: ${language} uses Latin script`)
  }

  console.log(`[Railway] ALL VALIDATION CHECKS PASSED for ${language}!`)
  return true
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// EXACT translation function from working Vercel code
export async function translateHTML(html, language, vertical, maxRetries = 3) {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY not configured")
  }

  if (language === "en") {
    return html
  }

  // EXACT model config from working Vercel code - NO maxOutputTokens limit!
  const model = genAI.getGenerativeModel({
    model: "gemini-3-flash-preview",
    generationConfig: {
      temperature: 0.3,
      // NO maxOutputTokens - let Gemini use its full capacity
    },
    safetySettings: [
      { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
      { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
      { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
      { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
    ],
  })

  // EXACT prompt from working Vercel code
  const prompt = `You are translating a complete webpage to ${language}.

CRITICAL RULES (FAILURE TO FOLLOW WILL RESULT IN REJECTION):
1. Translate ONLY text content between HTML tags
2. NEVER modify HTML tags, attributes, class names, IDs, or structure
3. Keep ALL image src paths exactly as-is
4. Keep ALL links href exactly as-is
5. Keep ALL data-* attributes exactly as-is
6. Preserve all formatting, line breaks, and whitespace structure
7. Return ONLY the complete translated HTML starting with <!DOCTYPE html>
8. Do NOT add any explanations, comments, or notes before or after the HTML
9. Your response must start with <!DOCTYPE html> and end with </html>

Context:
- Vertical: ${vertical}
- Target Language: ${language}
- This is a landing page, translate naturally and persuasively

HTML to translate:
${html}`

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`[Railway] Translation attempt ${attempt}/${maxRetries} for language: ${language}`)
      console.log(`[Railway] Original HTML length: ${html.length} characters`)

      const result = await model.generateContent(prompt)
      let translatedHTML = result.response.text()

      console.log(`[Railway] Received response from Gemini (${translatedHTML.length} chars)`)

      // EXACT cleanup logic from working Vercel code
      // Remove markdown code blocks (multiple formats)
      translatedHTML = translatedHTML.replace(/^```html\s*/i, "")
      translatedHTML = translatedHTML.replace(/^```\s*/i, "")
      translatedHTML = translatedHTML.replace(/\s*```$/i, "")

      // Remove any explanatory text before DOCTYPE
      const docTypeIndex = translatedHTML.search(/<!DOCTYPE\s+html>/i)
      if (docTypeIndex > 0) {
        console.log(`[Railway] Removing ${docTypeIndex} characters before DOCTYPE`)
        translatedHTML = translatedHTML.substring(docTypeIndex)
      }

      // Remove any text after closing html tag
      const htmlEndIndex = translatedHTML.toLowerCase().lastIndexOf("</html>")
      if (htmlEndIndex > 0) {
        translatedHTML = translatedHTML.substring(0, htmlEndIndex + 7) // 7 is length of '</html>'
      }

      translatedHTML = translatedHTML.trim()

      console.log(`[Railway] After cleanup: ${translatedHTML.length} characters`)

      const isValid = isValidTranslation(translatedHTML, language, html)
      console.log(`[Railway] Validation result: ${isValid}`)

      if (!isValid) {
        if (attempt < maxRetries) {
          const waitTime = 2000 * attempt
          console.log(`[Railway] Validation failed, retrying in ${waitTime}ms...`)
          await sleep(waitTime)
          continue
        } else {
          throw new Error(`Translation validation failed after ${maxRetries} attempts`)
        }
      }

      console.log(`[Railway] Translation successful on attempt ${attempt}!`)
      return translatedHTML
    } catch (error) {
      console.log(`[Railway] Translation attempt ${attempt} failed: ${error.message}`)

      if (attempt === maxRetries) {
        throw new Error(`Translation API failed after ${maxRetries} attempts: ${error.message}`)
      }

      const waitTime = 2000 * attempt
      console.log(`[Railway] Waiting ${waitTime}ms before retry...`)
      await sleep(waitTime)
    }
  }

  throw new Error("Unexpected translation failure")
}

// EXACT parallel translation from working Vercel code
export async function translateAllHTMLFiles(files, language, vertical) {
  console.log(`[Railway] Starting PARALLEL translation of ${files.length} HTML files to ${language}`)

  const translationPromises = files.map(async (file, index) => {
    console.log(
      `[Railway] [${index + 1}/${files.length}] Starting translation of ${file.filename}... (${file.html.length} chars)`,
    )

    try {
      const translatedHTML = await translateHTML(file.html, language, vertical)

      console.log(
        `[Railway] [${index + 1}/${files.length}] Successfully translated ${file.filename} (${translatedHTML.length} chars)`,
      )

      return {
        filename: file.filename,
        originalPath: file.originalPath,
        html: translatedHTML,
      }
    } catch (error) {
      console.log(`[Railway] Failed to translate ${file.filename}: ${error.message}`)
      throw error
    }
  })

  try {
    const translatedFiles = await Promise.all(translationPromises)
    console.log(`[Railway] Successfully translated all ${files.length} files!`)
    return translatedFiles
  } catch (error) {
    console.log(`[Railway] Parallel translation failed: ${error.message}`)
    throw error
  }
}
