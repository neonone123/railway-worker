import { createClient } from "@supabase/supabase-js"
import { put } from "@vercel/blob"
import JSZip from "jszip"
import { translateAllHTMLFiles } from "./gemini-translator.js"

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)

export async function processTranslationJob(data) {
  const { jobId, projectId, userId, templateZipUrl, processedHtmlFiles, language, projectName } = data

  console.log(`[Railway] ========== JOB ${jobId} START ==========`)
  console.log(`[Railway] Project ID: ${projectId}`)
  console.log(`[Railway] Target Language: ${language}`)
  console.log(`[Railway] Received ${processedHtmlFiles?.length || 0} processed HTML files`)

  try {
    if (!processedHtmlFiles || processedHtmlFiles.length === 0) {
      throw new Error("No processed HTML files received from Vercel")
    }

    await updateProgress(jobId, 15, "Downloading template assets...")

    const zipResponse = await fetch(templateZipUrl)
    if (!zipResponse.ok) {
      throw new Error(`Failed to download ZIP: ${zipResponse.status}`)
    }

    const zipBuffer = await zipResponse.arrayBuffer()
    console.log(`[Railway] ZIP downloaded: ${zipBuffer.byteLength} bytes`)

    const templateZip = await JSZip.loadAsync(zipBuffer)

    await updateProgress(jobId, 25, `Translating to ${language}...`)

    console.log(`[Railway] Starting parallel translation of ${processedHtmlFiles.length} files`)

    const translatedFiles = await translateAllHTMLFiles(processedHtmlFiles, language, "dating")

    console.log(`[Railway] All ${translatedFiles.length} files translated successfully`)

    await updateProgress(jobId, 85, "Creating download package...")

    const outputZip = new JSZip()

    let templateFolder = ""
    if (translatedFiles && translatedFiles.length > 0 && translatedFiles[0].originalPath) {
      const firstHtmlPath = translatedFiles[0].originalPath
      if (firstHtmlPath && firstHtmlPath.includes("/")) {
        templateFolder = firstHtmlPath.substring(0, firstHtmlPath.lastIndexOf("/") + 1)
        console.log(`[Railway] Template folder: ${templateFolder}`)
      }
    }

    // Copy all non-HTML files from original ZIP
    const allFilenames = Object.keys(templateZip.files)
    console.log(`[Railway] Total files in ZIP: ${allFilenames.length}`)

    const copyTasks = []
    for (const filename of allFilenames) {
      if (!filename) continue

      const file = templateZip.files[filename]
      if (!file) continue

      // Skip directories, Mac metadata, HTML files, and JSON files
      if (file.dir) continue
      if (filename.includes("__MACOSX/")) continue
      if (filename.split("/").pop().startsWith("._")) continue
      if (filename.endsWith(".DS_Store")) continue
      if (filename.toLowerCase().endsWith(".html")) continue
      if (filename.toLowerCase().endsWith(".json")) continue

      copyTasks.push(
        file.async("arraybuffer").then((content) => {
          outputZip.file(filename, content)
          console.log(`[Railway] Copied: ${filename}`)
        }),
      )
    }

    await Promise.all(copyTasks)
    console.log(`[Railway] Copied ${copyTasks.length} asset files`)

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
