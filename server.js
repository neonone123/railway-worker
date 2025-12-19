import express from "express"
import { processTranslationJob } from "./translator.js"

const app = express()
app.use(express.json())

const PORT = process.env.PORT || 3001

// Health check
app.get("/health", (req, res) => {
  res.json({ status: "ok", service: "translation-worker" })
})

// Translation webhook endpoint
app.post("/translate", async (req, res) => {
  const { projectId, templateZipUrl, targetLanguage, vertical, formData } = req.body

  // Validate request
  if (!projectId || !templateZipUrl || !targetLanguage) {
    return res.status(400).json({ error: "Missing required fields" })
  }

  console.log(`[Railway] Received translation job for project ${projectId}`)

  // Return immediately - processing happens in background
  res.json({ received: true, projectId })

  // Process translation asynchronously with unlimited retries
  processTranslationWithRetry(projectId, templateZipUrl, targetLanguage, vertical, formData)
})

async function processTranslationWithRetry(projectId, templateZipUrl, targetLanguage, vertical, formData) {
  let attempt = 0

  while (true) {
    attempt++
    console.log(`[Railway] Translation attempt ${attempt} for project ${projectId}`)

    try {
      await processTranslationJob(projectId, templateZipUrl, targetLanguage, vertical, formData)
      console.log(`[Railway] Translation completed successfully for project ${projectId}`)
      break // Success - exit loop
    } catch (error) {
      console.error(`[Railway] Translation attempt ${attempt} failed:`, error.message)

      // Wait before retrying (exponential backoff, max 5 minutes)
      const delay = Math.min(Math.pow(2, attempt) * 1000, 300000)
      console.log(`[Railway] Retrying in ${delay / 1000} seconds...`)
      await new Promise((resolve) => setTimeout(resolve, delay))
    }
  }
}

app.listen(PORT, () => {
  console.log(`[Railway] Translation worker running on port ${PORT}`)
})
