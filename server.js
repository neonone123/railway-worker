import express from "express"
import { processTranslationJob } from "./translator.js"

const app = express()
app.use(express.json())

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
  } = req.body

  if (!jobId || !projectId || !templateId || !language) {
    return res.status(400).json({ error: "Missing required fields" })
  }

  console.log(`[Railway] Received translation job ${jobId} for project ${projectId}`)

  res.json({ received: true, jobId, projectId })

  processTranslationWithRetry({
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

app.listen(PORT, () => {
  console.log(`[Railway] Translation worker running on port ${PORT}`)
})
