import express from "express"
import { processTranslationJob } from "./translator.js"

const app = express()
app.use(express.json({ limit: "50mb" })) // Increased limit to handle large HTML payloads

const PORT = process.env.PORT || 3001

app.get("/", (req, res) => {
  res.json({
    service: "PurePage Translation Worker",
    status: "running",
    endpoints: {
      health: "/health",
      translate: "POST /translate",
    },
  })
})

// Health check
app.get("/health", (req, res) => {
  res.json({ status: "ok", service: "translation-worker" })
})

// Translation webhook endpoint
app.post("/translate", async (req, res) => {
  const { jobId, projectId, userId, templateZipUrl, processedHtmlFiles, language, projectName } = req.body

  if (!jobId || !projectId || !templateZipUrl || !processedHtmlFiles || !language) {
    return res.status(400).json({ error: "Missing required fields" })
  }

  console.log(`[Railway] Received translation job ${jobId} for project ${projectId}`)
  console.log(`[Railway] Received ${processedHtmlFiles.length} processed HTML files`)

  res.json({ received: true, jobId, projectId })

  processTranslationWithRetry({
    jobId,
    projectId,
    userId,
    templateZipUrl,
    processedHtmlFiles,
    language,
    projectName,
  })
})

async function processTranslationWithRetry(data) {
  let attempt = 0

  while (true) {
    attempt++
    console.log(`[Railway] Translation attempt ${attempt} for job ${data.jobId}`)

    try {
      await processTranslationJob(data)
      console.log(`[Railway] Translation completed successfully for job ${data.jobId}`)
      break
    } catch (error) {
      console.error(`[Railway] Translation attempt ${attempt} failed:`, error.message)

      const delay = Math.min(Math.pow(2, attempt) * 1000, 300000)
      console.log(`[Railway] Retrying in ${delay / 1000} seconds...`)
      await new Promise((resolve) => setTimeout(resolve, delay))
    }
  }
}

app.listen(PORT, "0.0.0.0", () => {
  console.log(`[Railway] Translation worker running on port ${PORT}`)
})
