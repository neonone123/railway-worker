import { createClient } from "@supabase/supabase-js"
import { put } from "@vercel/blob"
import JSZip from "jszip"
import { translateAllHTMLFiles } from "./gemini-translator.js"

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

    const { data: template, error: templateError } = await supabase
      .from("generator_templates")
      .select("*")
      .eq("id", templateId)
      .eq("language", "en")
      .single()

    if (templateError || !template || !template.zip_url) {
      throw new Error(`Template not found: ${templateError?.message || "Missing ZIP URL"}`)
    }

    console.log(`[Railway] Template name: ${template.name}`)
    console.log(`[Railway] ZIP URL: ${template.zip_url}`)

    await updateProgress(jobId, 15, "Downloading template ZIP...")

    const zipResponse = await fetch(template.zip_url)
    if (!zipResponse.ok) {
      throw new Error(`Failed to download ZIP: ${zipResponse.status}`)
    }

    const zipBuffer = await zipResponse.arrayBuffer()
    console.log(`[Railway] ZIP downloaded: ${zipBuffer.byteLength} bytes`)

    const templateZip = await JSZip.loadAsync(zipBuffer)

    await updateProgress(jobId, 25, "Extracting HTML files...")

    const htmlFiles = []
    const allFilenames = Object.keys(templateZip.files)

    console.log(`[Railway] Total files in ZIP: ${allFilenames.length}`)

    for (const filename of allFilenames) {
      const file = templateZip.files[filename]

      // Skip directories and Mac metadata
      if (file.dir) continue
      if (filename.includes("__MACOSX/")) continue
      if (filename.split("/").pop().startsWith("._")) continue
      if (filename.endsWith(".DS_Store")) continue

      // Extract HTML files
      if (filename.toLowerCase().endsWith(".html")) {
        console.log(`[Railway] Found HTML: ${filename}`)
        const html = await file.async("text")
        const baseName = filename.split("/").pop()

        htmlFiles.push({
          filename: baseName,
          originalPath: filename,
          html: html,
        })

        console.log(`[Railway]   ${baseName}: ${html.length} characters`)
      }
    }

    console.log(`[Railway] Extracted ${htmlFiles.length} HTML files`)

    if (htmlFiles.length === 0) {
      throw new Error("No HTML files found in template ZIP")
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

    console.log(`[Railway] Token map: ${Object.keys(tokenMap).length} tokens`)

    await updateProgress(jobId, 40, "Replacing content tokens...")

    htmlFiles.forEach((file) => {
      let replacements = 0
      Object.entries(tokenMap).forEach(([tokenName, content]) => {
        const regex = new RegExp(`\\{\\{${tokenName}\\}\\}`, "gi")
        const matches = (file.html.match(regex) || []).length
        if (matches > 0) {
          file.html = file.html.replace(regex, content)
          replacements += matches
        }
      })
      console.log(`[Railway] ${file.filename}: ${replacements} token replacements`)
    })

    await updateProgress(jobId, 45, `Translating to ${language}...`)

    console.log(`[Railway] Starting parallel translation of ${htmlFiles.length} files`)

    const translatedFiles = await translateAllHTMLFiles(htmlFiles, language, vertical)

    console.log(`[Railway] All ${translatedFiles.length} files translated successfully`)

    await updateProgress(jobId, 85, "Creating download package...")

    const outputZip = new JSZip()

    // Detect template folder structure
    let templateFolder = ""
    if (translatedFiles && translatedFiles.length > 0 && translatedFiles[0].originalPath) {
      const firstHtmlPath = translatedFiles[0].originalPath
      if (firstHtmlPath && firstHtmlPath.includes("/")) {
        templateFolder = firstHtmlPath.substring(0, firstHtmlPath.lastIndexOf("/") + 1)
        console.log(`[Railway] Template folder: ${templateFolder}`)
      }
    } else {
      console.log(`[Railway] No template folder structure detected, using flat structure`)
    }

    // Copy all non-HTML files from original ZIP
    const copyTasks = []
    for (const filename of allFilenames) {
      if (!filename) continue

      const file = templateZip.files[filename]
      if (!file) continue

      // Skip directories, Mac metadata, and HTML files
      if (file.dir) continue
      if (filename.includes("__MACOSX/")) continue
      if (filename.split("/").pop().startsWith("._")) continue
      if (filename.endsWith(".DS_Store")) continue
      if (filename.toLowerCase().endsWith(".html")) continue

      copyTasks.push(
        file.async("arraybuffer").then((content) => {
          outputZip.file(filename, content)
          console.log(`[Railway] Copied: ${filename}`)
        }),
      )
    }

    await Promise.all(copyTasks)
    console.log(`[Railway] Copied ${copyTasks.length} asset files`)

    // Add translated HTML files
    translatedFiles.forEach((file) => {
      outputZip.file(file.originalPath, file.html)
      console.log(`[Railway] Added translated: ${file.originalPath}`)
    })

    // Generate final ZIP
    console.log(`[Railway] Generating final ZIP...`)
    const zipBlob = await outputZip.generateAsync({
      type: "arraybuffer",
      compression: "DEFLATE",
      compressionOptions: { level: 6 },
    })

    console.log(`[Railway] ZIP created: ${zipBlob.byteLength} bytes`)

    await updateProgress(jobId, 90, "Uploading files...")

    const blobFilename = `translations/${userId}/${Date.now()}-${projectName.replace(/[^a-z0-9]/gi, "-").toLowerCase()}.zip`

    const blob = await put(blobFilename, zipBlob, {
      access: "public",
      token: process.env.BLOB_READ_WRITE_TOKEN,
    })

    console.log(`[Railway] Uploaded: ${blob.url}`)

    await updateProgress(jobId, 95, "Finalizing...")

    // Decrement user credits
    await supabase.rpc("decrement_pages", { user_id_param: userId })
    console.log(`[Railway] Credits decremented`)

    // Update project
    const { error: projectError } = await supabase
      .from("projects")
      .update({
        status: "completed",
        zip_url: blob.url,
      })
      .eq("id", projectId)

    if (projectError) {
      console.error(`[Railway] Project update error:`, projectError)
      throw new Error(`Database update failed: ${projectError.message}`)
    }

    // Update queue
    const { error: queueError } = await supabase
      .from("translation_queue")
      .update({
        status: "completed",
        progress: 100,
        current_step: "Complete!",
        zip_url: blob.url,
        completed_at: new Date().toISOString(),
      })
      .eq("id", jobId)

    if (queueError) {
      console.error(`[Railway] Queue update error:`, queueError)
    }

    console.log(`[Railway] ========== JOB ${jobId} COMPLETED ==========`)
    return { success: true, zipUrl: blob.url }
  } catch (error) {
    console.error(`[Railway] ========== JOB ${jobId} FAILED ==========`)
    console.error(`[Railway] Error:`, error.message)
    console.error(`[Railway] Stack:`, error.stack)

    // Update queue status to failed
    await supabase
      .from("translation_queue")
      .update({
        status: "failed",
        error_message: error.message,
        current_step: `Failed: ${error.message}`,
      })
      .eq("id", jobId)
      .then(() => console.log(`[Railway] Marked job as failed in database`))
      .catch((err) => console.error(`[Railway] Failed to update error status:`, err))

    throw error
  }
}

async function updateProgress(jobId, progress, currentStep) {
  try {
    await supabase.from("translation_queue").update({ progress, current_step: currentStep }).eq("id", jobId)
    console.log(`[Railway] Progress: ${progress}% - ${currentStep}`)
  } catch (error) {
    console.error(`[Railway] Failed to update progress:`, error)
  }
}
