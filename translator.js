import { GoogleGenerativeAI } from "@google/generative-ai"
import { createClient } from "@supabase/supabase-js"
import { put } from "@vercel/blob"
import JSZip from "jszip"

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY)
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)

export async function processTranslationJob(projectId, templateZipUrl, targetLanguage, vertical, formData) {
  console.log(`[Railway] Starting translation for project ${projectId}`)

  // 1. Download template ZIP
  const templateResponse = await fetch(templateZipUrl)
  const templateBuffer = await templateResponse.arrayBuffer()
  const templateZip = await JSZip.loadAsync(templateBuffer)

  // 2. Find all HTML files recursively
  const htmlFiles = []
  const templateFolder = Object.keys(templateZip.files)[0].split("/")[0] + "/"

  for (const [path, file] of Object.entries(templateZip.files)) {
    if (!file.dir && path.toLowerCase().endsWith(".html")) {
      const html = await file.async("text")
      htmlFiles.push({ path, html })
      console.log(`[Railway] Found HTML file: ${path}`)
    }
  }

  // 3. Translate all HTML files in parallel
  console.log(`[Railway] Translating ${htmlFiles.length} files to ${targetLanguage}...`)
  const translatedFiles = await Promise.all(
    htmlFiles.map(({ path, html }) => translateHTML(html, targetLanguage, vertical, formData, path)),
  )

  // 4. Create new ZIP with translated files
  console.log(`[Railway] Creating output ZIP...`)
  const outputZip = new JSZip()

  // Copy all non-HTML files
  for (const [path, file] of Object.entries(templateZip.files)) {
    if (file.dir) continue
    if (path.toLowerCase().endsWith(".html")) continue

    const content = await file.async("arraybuffer")
    outputZip.file(path, content)
  }

  // Add translated HTML files
  for (let i = 0; i < htmlFiles.length; i++) {
    outputZip.file(htmlFiles[i].path, translatedFiles[i])
  }

  // Generate ZIP buffer
  const zipBuffer = await outputZip.generateAsync({
    type: "arraybuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  })

  // 5. Upload to Vercel Blob
  console.log(`[Railway] Uploading to Vercel Blob...`)
  const blob = await put(`${projectId}.zip`, zipBuffer, {
    access: "public",
    token: process.env.BLOB_READ_WRITE_TOKEN,
  })

  // 6. Update project in database
  console.log(`[Railway] Updating project ${projectId} in database...`)
  const { error } = await supabase
    .from("projects")
    .update({
      status: "completed",
      zip_url: blob.url,
      updated_at: new Date().toISOString(),
    })
    .eq("id", projectId)

  if (error) throw error

  console.log(`[Railway] Project ${projectId} completed successfully!`)
}

async function translateHTML(html, targetLanguage, vertical, formData, filename) {
  console.log(`[Railway] Translating ${filename}...`)

  const model = genAI.getGenerativeModel({ model: "gemini-3-flash-preview" })

  const prompt = `You are a professional website translator. Translate the following HTML content to ${targetLanguage}.

Context:
- Website vertical: ${vertical}
- Form data: ${JSON.stringify(formData)}

CRITICAL RULES:
1. Translate ALL text content visible to users
2. Keep ALL HTML structure, tags, classes, and IDs exactly the same
3. Do NOT translate: HTML tags, CSS classes, JavaScript code, URLs, or data attributes
4. Return ONLY the complete translated HTML, nothing else
5. Preserve all formatting, whitespace, and indentation

HTML to translate:

${html}`

  const result = await model.generateContent(prompt)
  const translatedHTML = result.response.text().trim()

  console.log(`[Railway] Translated ${filename} (${translatedHTML.length} chars)`)
  return translatedHTML
}
