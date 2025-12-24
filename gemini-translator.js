import { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } from "@google/generative-ai"

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "")

// Language character validation patterns
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function extractTextSegments(html) {
  const segments = []
  
  // Match text between HTML tags, but not inside script/style/code tags
  // Also skip attributes and tag names
  const tagPattern = /<(script|style|code|pre)[^>]*>[\s\S]*?<\/\1>|<[^>]+>|([^<]+)/gi
  
  let match
  let position = 0
  
  while ((match = tagPattern.exec(html)) !== null) {
    const fullMatch = match[0]
    const textContent = match[2] // This is the text between tags (if any)
    
    if (textContent && textContent.trim().length > 0) {
      // This is actual text content, not a tag
      segments.push({
        start: match.index,
        end: match.index + fullMatch.length,
        text: textContent,
        isTranslatable: true
      })
    }
  }
  
  return segments
}

function createTextChunks(segments, maxChunkSize = 5000) {
  const chunks = []
  let currentChunk = []
  let currentSize = 0
  
  for (const segment of segments) {
    if (currentSize + segment.text.length > maxChunkSize && currentChunk.length > 0) {
      // Start a new chunk
      chunks.push(currentChunk)
      currentChunk = []
      currentSize = 0
    }
    
    currentChunk.push(segment)
    currentSize += segment.text.length
  }
  
  if (currentChunk.length > 0) {
    chunks.push(currentChunk)
  }
  
  return chunks
}

async function translateTextChunk(textSegments, language, vertical, chunkIndex, totalChunks) {
  const model = genAI.getGenerativeModel({
    model: "gemini-3-flash-preview",
    generationConfig: {
      temperature: 0.3,
    },
    safetySettings: [
      { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
      { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
      { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
      { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
    ],
  })
  
  // Create a numbered list of text to translate
  const textList = textSegments.map((seg, i) => `[${i}] ${seg.text}`).join('\n')
  
  const prompt = `Translate the following numbered text segments to ${language}.

RULES:
1. Return ONLY the translated text in the EXACT same numbered format
2. Keep the [number] prefix exactly as-is
3. Translate naturally for a ${vertical} landing page
4. Do NOT add any explanations or notes
5. Preserve any numbers, URLs, or special characters within the text

Text segments to translate:
${textList}`

  const maxRetries = 3
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`[Railway] Chunk ${chunkIndex + 1}/${totalChunks}: Attempt ${attempt} (${textSegments.length} segments)`)
      
      const result = await model.generateContent(prompt)
      const response = result.response.text().trim()
      
      // Parse the response back into segments
      const translatedMap = new Map()
      const lines = response.split('\n')
      
      for (const line of lines) {
        const match = line.match(/^\[(\d+)\]\s*(.*)$/)
        if (match) {
          const index = parseInt(match[1])
          const translatedText = match[2]
          translatedMap.set(index, translatedText)
        }
      }
      
      // Verify we got all translations
      if (translatedMap.size < textSegments.length * 0.8) {
        console.log(`[Railway] Chunk ${chunkIndex + 1}: Only got ${translatedMap.size}/${textSegments.length} translations, retrying...`)
        await sleep(2000 * attempt)
        continue
      }
      
      // Validate that target language characters exist (for non-Latin languages)
      const strictLanguageCheck = ["ru", "ar", "zh", "ja", "ko", "he", "th", "hi", "el"]
      if (strictLanguageCheck.includes(language)) {
        const pattern = LANGUAGE_PATTERNS[language]
        const hasTargetChars = Array.from(translatedMap.values()).some(text => pattern.test(text))
        if (!hasTargetChars) {
          console.log(`[Railway] Chunk ${chunkIndex + 1}: No ${language} characters found, retrying...`)
          await sleep(2000 * attempt)
          continue
        }
      }
      
      console.log(`[Railway] Chunk ${chunkIndex + 1}/${totalChunks}: Successfully translated ${translatedMap.size} segments`)
      
      // Return the translated segments
      return textSegments.map((seg, i) => ({
        ...seg,
        translatedText: translatedMap.get(i) || seg.text // Fallback to original if missing
      }))
      
    } catch (error) {
      console.log(`[Railway] Chunk ${chunkIndex + 1}: Attempt ${attempt} failed: ${error.message}`)
      if (attempt === maxRetries) {
        throw error
      }
      await sleep(2000 * attempt)
    }
  }
  
  throw new Error(`Failed to translate chunk ${chunkIndex + 1}`)
}

function reassembleHTML(originalHTML, translatedSegments) {
  // Sort segments by position in reverse order so we can replace from end to start
  // This prevents position shifts from affecting subsequent replacements
  const sortedSegments = [...translatedSegments].sort((a, b) => b.start - a.start)
  
  let result = originalHTML
  
  for (const segment of sortedSegments) {
    if (segment.translatedText) {
      result = result.slice(0, segment.start) + segment.translatedText + result.slice(segment.end)
    }
  }
  
  return result
}

export async function translateHTML(html, language, vertical, maxRetries = 3) {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY not configured")
  }

  if (language === "en") {
    return html
  }

  const CHUNK_THRESHOLD = 15000 // Use chunked translation for files > 15K chars
  
  if (html.length <= CHUNK_THRESHOLD) {
    console.log(`[Railway] Small file (${html.length} chars), using direct translation`)
    return translateHTMLDirect(html, language, vertical, maxRetries)
  }
  
  console.log(`[Railway] Large file (${html.length} chars), using CHUNKED translation`)
  
  // Step 1: Extract text segments
  const segments = extractTextSegments(html)
  console.log(`[Railway] Extracted ${segments.length} text segments`)
  
  if (segments.length === 0) {
    console.log(`[Railway] No translatable text found, returning original`)
    return html
  }
  
  // Step 2: Group into chunks
  const chunks = createTextChunks(segments, 4000)
  console.log(`[Railway] Created ${chunks.length} chunks for translation`)
  
  // Step 3: Translate each chunk sequentially (to avoid rate limits)
  const allTranslatedSegments = []
  
  for (let i = 0; i < chunks.length; i++) {
    console.log(`[Railway] Translating chunk ${i + 1}/${chunks.length}...`)
    const translatedChunk = await translateTextChunk(chunks[i], language, vertical, i, chunks.length)
    allTranslatedSegments.push(...translatedChunk)
    
    // Small delay between chunks to avoid rate limits
    if (i < chunks.length - 1) {
      await sleep(500)
    }
  }
  
  // Step 4: Reassemble HTML with translated text
  console.log(`[Railway] Reassembling HTML with ${allTranslatedSegments.length} translated segments`)
  const translatedHTML = reassembleHTML(html, allTranslatedSegments)
  
  // Validate the result
  const hasHTML = translatedHTML.toLowerCase().includes("<html") && translatedHTML.toLowerCase().includes("</html>")
  if (!hasHTML) {
    throw new Error("Chunked translation corrupted HTML structure")
  }
  
  // Validate language characters for non-Latin languages
  const strictLanguageCheck = ["ru", "ar", "zh", "ja", "ko", "he", "th", "hi", "el"]
  if (strictLanguageCheck.includes(language)) {
    const pattern = LANGUAGE_PATTERNS[language]
    if (!pattern.test(translatedHTML)) {
      throw new Error(`No ${language} characters found in translated HTML`)
    }
  }
  
  console.log(`[Railway] Chunked translation complete: ${html.length} -> ${translatedHTML.length} chars`)
  return translatedHTML
}

async function translateHTMLDirect(html, language, vertical, maxRetries = 3) {
  const model = genAI.getGenerativeModel({
    model: "gemini-3-flash-preview",
    generationConfig: {
      temperature: 0.3,
    },
    safetySettings: [
      { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
      { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
      { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
      { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
    ],
  })

  const prompt = `You are translating a complete webpage to ${language}.

CRITICAL RULES:
1. Translate ONLY text content between HTML tags
2. NEVER modify HTML tags, attributes, class names, IDs, or structure
3. Keep ALL image src paths exactly as-is
4. Keep ALL links href exactly as-is
5. Return ONLY the complete translated HTML starting with <!DOCTYPE html>
6. Your response must start with <!DOCTYPE html> and end with </html>

Context: ${vertical} landing page
Target Language: ${language}

HTML to translate:
${html}`

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`[Railway] Direct translation attempt ${attempt}/${maxRetries}`)
      
      const result = await model.generateContent(prompt)
      let translatedHTML = result.response.text()
      
      // Clean up response
      translatedHTML = translatedHTML.replace(/^```html\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/i, "")
      
      const docTypeIndex = translatedHTML.search(/<!DOCTYPE\s+html>/i)
      if (docTypeIndex > 0) {
        translatedHTML = translatedHTML.substring(docTypeIndex)
      }
      
      const htmlEndIndex = translatedHTML.toLowerCase().lastIndexOf("</html>")
      if (htmlEndIndex > 0) {
        translatedHTML = translatedHTML.substring(0, htmlEndIndex + 7)
      }
      
      translatedHTML = translatedHTML.trim()
      
      // Validate
      const hasHTML = translatedHTML.toLowerCase().includes("<html") && translatedHTML.toLowerCase().includes("</html>")
      if (!hasHTML) {
        throw new Error("Missing HTML structure")
      }
      
      console.log(`[Railway] Direct translation successful: ${translatedHTML.length} chars`)
      return translatedHTML
      
    } catch (error) {
      console.log(`[Railway] Direct translation attempt ${attempt} failed: ${error.message}`)
      if (attempt === maxRetries) throw error
      await sleep(2000 * attempt)
    }
  }
  
  throw new Error("Direct translation failed")
}

// Translate all HTML files
export async function translateAllHTMLFiles(files, language, vertical) {
  console.log(`[Railway] Starting translation of ${files.length} HTML files to ${language}`)

  const results = []
  
  for (let i = 0; i < files.length; i++) {
    const file = files[i]
    console.log(`[Railway] [${i + 1}/${files.length}] Translating ${file.filename} (${file.html.length} chars)`)
    
    try {
      const translatedHTML = await translateHTML(file.html, language, vertical)
      
      console.log(`[Railway] [${i + 1}/${files.length}] Successfully translated ${file.filename}`)
      
      results.push({
        filename: file.filename,
        originalPath: file.originalPath,
        html: translatedHTML,
      })
    } catch (error) {
      console.log(`[Railway] [${i + 1}/${files.length}] FAILED to translate ${file.filename}: ${error.message}`)
      throw error
    }
  }
  
  console.log(`[Railway] All ${files.length} files translated successfully!`)
  return results
}
