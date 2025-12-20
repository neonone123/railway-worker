import { GoogleGenerativeAI } from "@google/generative-ai"
import { createClient } from "@supabase/supabase-js"
import { put } from "@vercel/blob"
import JSZip from "jszip"

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY)
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)

export async function processTranslationJob(data) {
  const {
    jobId,
    projectId,
    userId,
    templateId,
    language,
    vertical,
    trafficSource,
    tone,
    siteName,
    contactEmail,
    projectName,
  } = data

  console.log(`[Railway] ========== JOB ${jobId} START ==========`)
  console.log(`[Railway] Project ID: ${projectId}`)
  console.log(`[Railway] Template ID: ${templateId}`)
  console.log(`[Railway] Target Language: ${language}`)

  try {
    await updateProgress(jobId, 5, "Fetching template files...")

    const { data: template } = await supabase
      .from("generator_templates")
      .select("*")
      .eq("id", templateId)
      .eq("language", "en")
      .single()

    if (!template || !template.zip_url) {
      throw new Error("Template not found or missing ZIP URL")
    }

    console.log(`[Railway] Template name: ${template.name}`)
    console.log(`[Railway] ZIP URL: ${template.zip_url}`)

    await updateProgress(jobId, 15, "Downloading template ZIP...")

    const zipResponse = await fetch(template.zip_url)
    if (!zipResponse.ok) {
      throw new Error(`Failed to download ZIP: ${zipResponse.status} ${zipResponse.statusText}`)
    }

    const zipBuffer = await zipResponse.arrayBuffer()
    console.log(`[Railway] ZIP downloaded: ${zipBuffer.byteLength} bytes`)

    const templateZip = await JSZip.loadAsync(zipBuffer)
    console.log(`[Railway] ZIP loaded successfully`)

    const allFilesInZip = Object.keys(templateZip.files)
    console.log(`[Railway] ===== ALL FILES IN ZIP (${allFilesInZip.length} total) =====`)
    allFilesInZip.forEach((filename) => {
      const file = templateZip.files[filename]
      console.log(`[Railway]   ${file.dir ? "[DIR]" : "[FILE]"} ${filename}`)
    })
    console.log(`[Railway] ===== END FILE LIST =====`)

    // Filter out Mac metadata
    const cleanFiles = allFilesInZip.filter((filename) => {
      if (filename.includes("__MACOSX/")) return false
      const baseName = filename.split("/").pop()
      if (baseName.startsWith("._")) return false
      if (baseName === ".DS_Store") return false
      return true
    })

    console.log(`[Railway] Clean files after filtering: ${cleanFiles.length}`)

    await updateProgress(jobId, 25, "Extracting HTML files...")

    const htmlFiles = []

    for (const filename of cleanFiles) {
      const file = templateZip.files[filename]
      if (file.dir) continue

      const lowerFilename = filename.toLowerCase()
      if (lowerFilename.endsWith(".html")) {
        console.log(`[Railway] Found HTML file: ${filename}`)
        const html = await file.async("text")
        const htmlLength = html.length
        console.log(`[Railway]   Content length: ${htmlLength} characters`)
        console.log(`[Railway]   First 100 chars: ${html.substring(0, 100)}...`)

        const baseName = filename.split("/").pop()
        htmlFiles.push({ filename: baseName, originalPath: filename, html })
      }
    }

    console.log(`[Railway] Total HTML files found: ${htmlFiles.length}`)
    htmlFiles.forEach((f) => console.log(`[Railway]   - ${f.filename} (${f.html.length} chars)`))

    if (htmlFiles.length === 0) {
      throw new Error("No HTML files found in template ZIP after filtering")
    }

    await updateProgress(jobId, 35, "Fetching content snippets...")

    const { data: snippets } = await supabase
      .from("generator_snippet_banks")
      .select("*")
      .eq("vertical", vertical)
      .eq("traffic_source", trafficSource)
      .eq("language", "en")
      .contains("tags", [tone])

    console.log(`[Railway] Found ${snippets?.length || 0} content snippets`)

    const tokenMap = {
      site_name: siteName,
      contact: contactEmail,
    }

    if (snippets) {
      snippets.forEach((snippet) => {
        if (snippet.token_name && snippet.content) {
          tokenMap[snippet.token_name] = snippet.content
        }
      })
    }

    console.log(`[Railway] Token map has ${Object.keys(tokenMap).length} tokens`)

    await updateProgress(jobId, 40, "Replacing content tokens...")

    htmlFiles.forEach((file) => {
      let replacements = 0
      Object.entries(tokenMap).forEach(([tokenName, content]) => {
        const regex = new RegExp(`\\{\\{${tokenName}\\}\\}`, "gi")
        const beforeLength = file.html.length
        file.html = file.html.replace(regex, content)
        if (file.html.length !== beforeLength) replacements++
      })
      console.log(`[Railway] ${file.filename}: Made ${replacements} token replacements`)
    })

    await updateProgress(jobId, 45, `Translating to ${language}...`)

    console.log(`[Railway] Starting parallel translation of ${htmlFiles.length} files...`)

    const translatedFiles = await Promise.all(
      htmlFiles.map(async (file, index) => {
        const progress = 45 + Math.floor(((index + 1) / htmlFiles.length) * 40)
        await updateProgress(jobId, progress, `Translating ${file.filename}...`)

        console.log(`[Railway] Translating ${file.filename} (${file.html.length} chars)...`)
        const translatedHtml = await translateHTML(file.html, language, vertical)
        console.log(`[Railway] ✓ ${file.filename} translated (${translatedHtml.length} chars)`)

        return { filename: file.filename, originalPath: file.originalPath, html: translatedHtml }
      }),
    )

    console.log(`[Railway] All translations complete`)

    await updateProgress(jobId, 85, "Creating download package...")

    const outputZip = new JSZip()

    let templateFolder = ""
    const firstHtmlWithFolder = translatedFiles.find((f) => f.originalPath.includes("/"))
    if (firstHtmlWithFolder) {
      templateFolder = firstHtmlWithFolder.originalPath.split("/")[0] + "/"
      console.log(`[Railway] Template folder detected: ${templateFolder}`)
    } else {
      console.log(`[Railway] No template folder, using root`)
    }

    // Copy all non-HTML files from original ZIP
    const copyPromises = cleanFiles.map(async (filename) => {
      const file = templateZip.files[filename]
      if (file.dir || filename.toLowerCase().endsWith(".html")) {
        return null
      }
      const content = await file.async("arraybuffer")
      return { filename, content }
    })

    const copiedFiles = (await Promise.all(copyPromises)).filter((f) => f !== null)
    console.log(`[Railway] Copying ${copiedFiles.length} non-HTML files...`)

    copiedFiles.forEach((fileData) => {
      outputZip.file(fileData.filename, fileData.content)
      console.log(`[Railway]   Copied: ${fileData.filename}`)
    })

    // Add translated HTML files
    console.log(`[Railway] Adding ${translatedFiles.length} translated HTML files...`)
    translatedFiles.forEach((file) => {
      const fullPath = templateFolder ? templateFolder + file.filename : file.filename
      outputZip.file(fullPath, file.html)
      console.log(`[Railway]   Added: ${fullPath} (${file.html.length} chars)`)
    })

    console.log(`[Railway] Generating ZIP file...`)
    const zipBlob = await outputZip.generateAsync({
      type: "arraybuffer",
      compression: "DEFLATE",
      compressionOptions: { level: 6 },
    })

    console.log(`[Railway] ZIP generated: ${zipBlob.byteLength} bytes`)

    await updateProgress(jobId, 90, "Uploading files...")

    const blobFilename = `translations/${userId}/${Date.now()}-${projectName.replace(/[^a-z0-9]/gi, "-").toLowerCase()}.zip`
    console.log(`[Railway] Uploading to Blob: ${blobFilename}`)

    const blob = await put(blobFilename, zipBlob, {
      access: "public",
      token: process.env.BLOB_READ_WRITE_TOKEN,
    })

    console.log(`[Railway] Uploaded successfully: ${blob.url}`)

    await updateProgress(jobId, 95, "Updating database...")

    await supabase.rpc("decrement_pages", { user_id_param: userId })
    console.log(`[Railway] Credits decremented`)

    const { error: projectUpdateError } = await supabase
      .from("projects")
      .update({
        status: "completed",
        zip_url: blob.url,
      })
      .eq("id", projectId)

    if (projectUpdateError) {
      console.error(`[Railway] Failed to update project:`, projectUpdateError)
      throw new Error(`Failed to update project: ${projectUpdateError.message}`)
    }

    console.log(`[Railway] Project updated`)

    const { error: queueUpdateError } = await supabase
      .from("translation_queue")
      .update({
        status: "completed",
        progress: 100,
        current_step: "Translation complete!",
        zip_url: blob.url,
        completed_at: new Date().toISOString(),
      })
      .eq("id", jobId)

    if (queueUpdateError) {
      console.error(`[Railway] Failed to update queue:`, queueUpdateError)
    }

    console.log(`[Railway] ========== JOB ${jobId} COMPLETED ==========`)
  } catch (error) {
    console.error(`[Railway] ========== JOB ${jobId} FAILED ==========`)
    console.error(`[Railway] Error:`, error)
    console.error(`[Railway] Stack:`, error.stack)

    await supabase
      .from("translation_queue")
      .update({
        status: "failed",
        error_message: error.message,
        current_step: `Error: ${error.message}`,
      })
      .eq("id", jobId)

    throw error
  }
}

async function updateProgress(jobId, progress, currentStep) {
  await supabase.from("translation_queue").update({ progress, current_step: currentStep }).eq("id", jobId)
  console.log(`[Railway] Progress: ${progress}% - ${currentStep}`)
}

async function translateHTML(html, targetLanguage, vertical) {
  console.log(`[Railway] Calling Gemini API for translation...`)
  const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash-exp" })

  const prompt = `You are translating a complete webpage to ${targetLanguage}.

CRITICAL RULES:
1. Translate ONLY text content between HTML tags
2. NEVER modify HTML tags, attributes, class names, IDs, or structure
3. Keep ALL image src paths, links href, and data-* attributes exactly as-is
4. Preserve all formatting and whitespace
5. Return ONLY the complete translated HTML starting with <!DOCTYPE html>
6. Do NOT add explanations or markdown formatting

Context:
- Vertical: ${vertical}
- Target Language: ${targetLanguage}

HTML to translate:
${html}`

  const result = await model.generateContent(prompt)
  let translatedHTML = result.response.text()

  console.log(`[Railway] Gemini returned ${translatedHTML.length} characters`)

  translatedHTML = translatedHTML.replace(/^```html\s*/i, "")
  translatedHTML = translatedHTML.replace(/^```\s*/i, "")
  translatedHTML = translatedHTML.replace(/\s*```$/i, "")

  const docTypeIndex = translatedHTML.search(/<!DOCTYPE\s+html>/i)
  if (docTypeIndex > 0) {
    translatedHTML = translatedHTML.substring(docTypeIndex)
  }

  const htmlEndIndex = translatedHTML.toLowerCase().lastIndexOf("</html>")
  if (htmlEndIndex > 0) {
    translatedHTML = translatedHTML.substring(0, htmlEndIndex + 7)
  }

  return translatedHTML.trim()
}
