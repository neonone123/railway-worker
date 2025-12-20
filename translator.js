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

  console.log(`[Railway] Starting translation job ${jobId} for project ${projectId}`)

  try {
    await supabase
      .from("translation_queue")
      .update({
        status: "translating",
        started_at: new Date().toISOString(),
        progress: 5,
        current_step: "Fetching template files...",
      })
      .eq("id", jobId)

    const { data: template } = await supabase
      .from("generator_templates")
      .select("*")
      .eq("id", templateId)
      .eq("language", "en")
      .single()

    if (!template || !template.zip_url) {
      throw new Error("Template not found or missing ZIP URL")
    }

    console.log(`[Railway] Fetching template ZIP from: ${template.zip_url}`)

    await updateProgress(jobId, 15, "Loading template HTML files...")

    const zipResponse = await fetch(template.zip_url)
    const zipBuffer = await zipResponse.arrayBuffer()
    const templateZip = await JSZip.loadAsync(zipBuffer)

    const htmlFiles = []

    const allFiles = Object.keys(templateZip.files).filter((filename) => {
      if (filename.includes("__MACOSX")) return false
      const baseName = filename.split("/").pop()
      if (baseName.startsWith("._")) return false
      if (baseName === ".DS_Store") return false
      return true
    })

    // Find all HTML files in the ZIP
    for (const filename of allFiles) {
      const file = templateZip.files[filename]
      if (file.dir) continue

      const lowerFilename = filename.toLowerCase()
      if (lowerFilename.endsWith(".html")) {
        const html = await file.async("text")
        const baseName = filename.split("/").pop()
        htmlFiles.push({ filename: baseName, html })
        console.log(`[Railway] Found HTML file: ${filename}`)
      }
    }

    if (htmlFiles.length === 0) {
      throw new Error("No HTML files found in template ZIP")
    }

    await updateProgress(jobId, 25, "Fetching content snippets...")

    const { data: snippets } = await supabase
      .from("generator_snippet_banks")
      .select("*")
      .eq("vertical", vertical)
      .eq("traffic_source", trafficSource)
      .eq("language", "en")
      .contains("tags", [tone])

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

    await updateProgress(jobId, 35, "Replacing content tokens...")

    htmlFiles.forEach((file) => {
      Object.entries(tokenMap).forEach(([tokenName, content]) => {
        const regex = new RegExp(`\\{\\{${tokenName}\\}\\}`, "gi")
        file.html = file.html.replace(regex, content)
      })
    })

    await updateProgress(jobId, 45, `Translating to ${language}...`)

    console.log(`[Railway] Translating ${htmlFiles.length} HTML files to ${language} in parallel...`)

    const translatedFiles = await Promise.all(
      htmlFiles.map(async (file, index) => {
        const progress = 45 + Math.floor(((index + 1) / htmlFiles.length) * 40)
        await updateProgress(jobId, progress, `Translating ${file.filename}...`)

        const translatedHtml = await translateHTML(file.html, language, vertical)
        console.log(`[Railway] Translated ${file.filename} successfully`)
        return { filename: file.filename, html: translatedHtml }
      }),
    )

    await updateProgress(jobId, 85, "Creating download package...")

    const outputZip = new JSZip()

    let templateFolder = ""
    const firstRealFile = allFiles.find((f) => {
      const file = templateZip.files[f]
      return !file.dir && f.includes("/") && !f.includes("__MACOSX") && !f.split("/").pop().startsWith("._")
    })
    if (firstRealFile) {
      templateFolder = firstRealFile.split("/")[0] + "/"
    }

    console.log(`[Railway] Template folder: ${templateFolder || "(root)"}`)

    const copyPromises = allFiles.map(async (filename) => {
      const file = templateZip.files[filename]
      if (file.dir || filename.toLowerCase().endsWith(".html")) {
        return null
      }
      const content = await file.async("arraybuffer")
      return { filename, content }
    })

    const copiedFiles = (await Promise.all(copyPromises)).filter((f) => f !== null)
    copiedFiles.forEach((fileData) => {
      outputZip.file(fileData.filename, fileData.content)
    })

    // Add translated HTML files
    translatedFiles.forEach((file) => {
      const fullPath = templateFolder ? templateFolder + file.filename : file.filename
      outputZip.file(fullPath, file.html)
    })

    const zipBlob = await outputZip.generateAsync({
      type: "arraybuffer",
      compression: "DEFLATE",
      compressionOptions: { level: 6 },
    })

    await updateProgress(jobId, 90, "Uploading files...")

    console.log(`[Railway] Uploading ZIP to Vercel Blob...`)
    const blob = await put(
      `translations/${userId}/${Date.now()}-${projectName.replace(/[^a-z0-9]/gi, "-").toLowerCase()}.zip`,
      zipBlob,
      {
        access: "public",
        token: process.env.BLOB_READ_WRITE_TOKEN,
      },
    )

    await updateProgress(jobId, 95, "Saving project...")

    await supabase.rpc("decrement_pages", { user_id_param: userId })

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

    console.log(`[Railway] Project updated with ZIP URL: ${blob.url}`)

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

    console.log(`[Railway] Job ${jobId} completed successfully!`)
  } catch (error) {
    console.error(`[Railway] Job ${jobId} failed:`, error)

    await supabase
      .from("translation_queue")
      .update({
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
  const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" })

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
