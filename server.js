import express from "express"
import { processTranslationJob } from "./translator.js"

const app = express()
app.use(express.json({ limit: "50mb" }))

const PORT = process.env.PORT || 3001

const startupTime = new Date()
const isReady = true

app.get("/", (req, res) => {
  res.json({
    service: "PurePage Translation Worker",
    status: "running",
    uptime: Math.floor((Date.now() - startupTime.getTime()) / 1000),
    ready: isReady,
    endpoints: {
      health: "/health",
      readiness: "/ready",
      translate: "POST /translate",
    },
  })
})

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    service: "translation-worker",
    uptime: Math.floor((Date.now() - startupTime.getTime()) / 1000),
    timestamp: new Date().toISOString(),
  })
})

app.get("/ready", (req, res) => {
  if (isReady) {
    res.json({ ready: true })
  } else {
    res.status(503).json({ ready: false })
  }
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

process.on("uncaughtException", (error) => {
  console.error("[Railway] Uncaught Exception:", error)
  console.error(error.stack)
})

process.on("unhandledRejection", (reason, promise) => {
  console.error("[Railway] Unhandled Rejection at:", promise, "reason:", reason)
})

app.listen(PORT, () => {
  console.log(`[Railway] Translation worker running on port ${PORT}`)
  console.log(`[Railway] Health check available at http://localhost:${PORT}/health`)
  console.log(`[Railway] Ready check available at http://localhost:${PORT}/ready`)
})
