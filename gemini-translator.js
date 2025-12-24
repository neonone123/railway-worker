import { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } from "@google/generative-ai"

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "")

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
}

function isValidTranslation(html, language, originalHtml) {
  console.log(`[Railway] 🔍 Validating translation for language: ${language}`)
  console.log(`[Railway] Original HTML length: ${originalHtml.length}, Translated HTML length: ${html.length}`)

  // Check 1: Has basic HTML structure
  const hasHTML = html.toLowerCase().includes("<html") && html.toLowerCase().includes("</html>")
  if (!hasHTML) {
    console.error("[Railway] ❌ Validation failed: Missing HTML structure")
    return false
  }
  console.log("[Railway] ✅ Check 1 passed: HTML structure present")

  // Check 2: Not empty
  if (html.length < 200) {
    console.error(`[Railway] ❌ Validation failed: Translation too short (${html.length} characters)`)
    return false
  }
  console.log(`[Railway] ✅ Check 2 passed: Sufficient length (${html.length} chars)`)

  // Check 3: For non-Latin languages, check if target characters exist
  const strictLanguageCheck = ["ru", "ar", "zh", "ja", "ko", "he", "th", "hi", "el"]
  if (strictLanguageCheck.includes(language)) {
    const pattern = LANGUAGE_PATTERNS[language]
    if (pattern && !pattern.test(html)) {
      console.error(`[Railway] ❌ Validation failed: No ${language} characters found in translation`)
      return false
    }
    console.log(`[Railway] ✅ Check 3 passed: ${language.toUpperCase()} characters detected`)
  }

  console.log(`[Railway] ✅✅✅ ALL validation checks passed for ${language}!`)
  return true
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function withTimeout(promise, timeoutMs, errorMessage) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(errorMessage)), timeoutMs)),
  ])
}

export async function translateHTML(html, language, vertical, maxRetries = 3) {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY not configured")
  }

  if (language === "en") {
    return html
  }

  const model = genAI.getGenerativeModel({
    model: "gemini-2.0-flash-exp",
    generationConfig: {
      temperature: 0.3,
    },
    safetySettings: [
      {
        category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,
        threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH,
      },
      {
        category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
        threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH,
      },
      {
        category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
        threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH,
      },
      {
        category: HarmCategory.HARM_CATEGORY_HARASSMENT,
        threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH,
      },
    ],
  })

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
      console.log(`[Railway] 🔄 Translation attempt ${attempt}/${maxRetries} for language: ${language}`)
      console.log(`[Railway] Original HTML length: ${html.length} characters`)

      const result = await withTimeout(
        model.generateContent(prompt),
        90000,
        `Gemini API timeout after 90 seconds for ${language} translation`,
      )
      let translatedHTML = result.response.text()

      console.log(`[Railway] ✉️ Received response from Gemini (${translatedHTML.length} chars)`)

      // Remove markdown code blocks
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
        translatedHTML = translatedHTML.substring(0, htmlEndIndex + 7)
      }

      translatedHTML = translatedHTML.trim()

      console.log(`[Railway] 🧹 After cleanup: ${translatedHTML.length} characters`)

      const validationResult = isValidTranslation(translatedHTML, language, html)
      console.log(`[Railway] 📋 Validation result: ${validationResult}`)

      if (!validationResult) {
        if (attempt < maxRetries) {
          console.log(`[Railway] ⚠️ Validation failed, retrying in ${2 * attempt} seconds...`)
          await sleep(2000 * attempt)
          continue
        } else {
          throw new Error(`Translation validation failed after ${maxRetries} attempts`)
        }
      }

      console.log(`[Railway] ✅ Translation successful on attempt ${attempt}!`)
      return translatedHTML
    } catch (error) {
      console.error(`[Railway] ❌ Translation attempt ${attempt} failed:`, error)
      console.error(`[Railway] Error message: ${error.message}`)
      console.error(`[Railway] Error stack:`, error.stack)

      if (attempt === maxRetries) {
        throw new Error(`Translation API failed after ${maxRetries} attempts: ${error.message}`)
      }

      const waitTime = 2000 * attempt
      console.log(`[Railway] ⏳ Waiting ${waitTime}ms before retry ${attempt + 1}...`)
      await sleep(waitTime)
    }
  }
}

export async function translateAllHTMLFiles(files, language, vertical) {
  console.log(`[Railway] 🌍 Starting PARALLEL translation of ${files.length} HTML files to ${language}`)

  const translationPromises = files.map(async (file, index) => {
    try {
      console.log(
        `[Railway] 📄 [${index + 1}/${files.length}] Starting translation of ${file.filename}... (${file.html.length} chars)`,
      )

      const translatedHTML = await translateHTML(file.html, language, vertical)

      console.log(
        `[Railway] ✅ [${index + 1}/${files.length}] Successfully translated ${file.filename} (${translatedHTML.length} chars)`,
      )

      return {
        filename: file.filename,
        html: translatedHTML,
        success: true,
      }
    } catch (error) {
      console.error(`[Railway] ❌❌❌ FAILED to translate ${file.filename}:`, error.message)
      console.error(`[Railway] Error stack:`, error.stack)

      return {
        filename: file.filename,
        html: null,
        success: false,
        error: error.message,
      }
    }
  })

  const results = await Promise.all(translationPromises)

  const failures = results.filter((r) => !r.success)
  if (failures.length > 0) {
    console.error(`[Railway] ❌ ${failures.length} file(s) failed to translate:`)
    failures.forEach((f) => {
      console.error(`[Railway]   - ${f.filename}: ${f.error}`)
    })
    throw new Error(`Failed to translate ${failures.length} file(s): ${failures.map((f) => f.filename).join(", ")}`)
  }

  const translatedFiles = results.filter((r) => r.success)
  console.log(`[Railway] 🎉 Successfully translated all ${translatedFiles.length} files in parallel!`)

  return translatedFiles
}
