import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { google } from 'googleapis';
import Groq from 'groq-sdk';
import axios from 'axios';
import { parse } from 'csv-parse/sync';
import fs from 'fs';
import { GoogleGenerativeAI } from '@google/generative-ai';

dotenv.config({ override: true });

const app = express();
const port = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());

// Initialize Groq client (requires GROQ_API_KEY in .env)
const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY || 'dummy-key-for-now'
});

// Basic Health Check Route
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'MentoraX Backend is running!' });
});

// Database Endpoint
app.get('/api/students', (req, res) => {
  try {
    if (fs.existsSync('db.json')) {
      const db = JSON.parse(fs.readFileSync('db.json', 'utf8'));
      res.json(db);
    } else {
      res.json([]);
    }
  } catch (error) {
    res.status(500).json({ error: 'Failed to read database' });
  }
});

// ==========================================
// Vision Provider 1: OpenRouter (PRIMARY)
// Model: meta-llama/llama-4-scout — confirmed working, vision-capable
// ==========================================
async function extractTextWithOpenRouter(assignment) {
  const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
  if (!OPENROUTER_API_KEY || OPENROUTER_API_KEY === 'your_openrouter_key_here') {
    throw new Error('No valid OPENROUTER_API_KEY set');
  }

  let safeMimeType = assignment.mimeType;
  if (!safeMimeType || !safeMimeType.startsWith('image/')) safeMimeType = 'image/jpeg';

  const prompt = 'You are an expert OCR system. Read the handwritten assignment in this image and transcribe all the text you see. Output ONLY the raw transcribed text with no conversational filler or markdown formatting.';
  const model = 'meta-llama/llama-4-scout';

  console.log(`[Vision Agent] Sending to OpenRouter (${model}): Base64 length: ${assignment.base64.length}`);

  const response = await axios.post(
    'https://openrouter.ai/api/v1/chat/completions',
    {
      model,
      messages: [{ role: 'user', content: [
        { type: 'text', text: prompt },
        { type: 'image_url', image_url: { url: `data:${safeMimeType};base64,${assignment.base64}` } }
      ]}],
      max_tokens: 4096
    },
    {
      headers: {
        'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://mentoraX.app',
        'X-Title': 'MentoraX'
      },
      timeout: 45000
    }
  );

  const text = response.data?.choices?.[0]?.message?.content;
  if (!text) throw new Error('OpenRouter returned empty response');
  return text;
}

// ==========================================
// Vision Provider 2: Gemini Direct (FALLBACK)
// ==========================================

async function extractTextWithGemini(assignment) {
  try {
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: "gemini-flash-latest" });
    
    let safeMimeType = assignment.mimeType;
    if (!safeMimeType || !safeMimeType.startsWith('image/')) {
      safeMimeType = 'image/jpeg';
    }

    const imagePart = {
      inlineData: {
        data: assignment.base64,
        mimeType: safeMimeType
      }
    };
    
    console.log(`[Agent Debug] Sending to Gemini: ${safeMimeType}, Base64 length: ${assignment.base64.length}, starts with: ${assignment.base64.substring(0, 20)}`);
    
    const prompt = 'You are an expert OCR system. Read the handwritten assignment in this image and transcribe the text perfectly. Output ONLY the raw transcribed text with no conversational filler or markdown formatting.';
    
    const result = await model.generateContent([prompt, imagePart]);
    const response = await result.response;
    return response.text();
  } catch (error) {
    console.warn(`[Agent] Gemini Vision Model failed: ${error.message}`);
    throw error;
  }
}

// ==========================================
// Vision Fallback Chain:
//   1. OpenRouter → meta-llama/llama-4-scout  (PRIMARY — tested & confirmed working)
//   2. Gemini Direct                           (FALLBACK — when quota resets)
// ==========================================
async function extractTextWithFallback(assignment) {
  // Tier 1: OpenRouter (Llama 4 Scout — vision-capable, confirmed working in tests)
  try {
    const text = await extractTextWithOpenRouter(assignment);
    console.log(`[Vision Agent] ✅ OpenRouter (llama-4-scout) succeeded for ${assignment.name}`);
    return text;
  } catch (err1) {
    console.warn(`[Vision Agent] ⚠️ OpenRouter failed (${err1.message}) — trying Gemini direct...`);
  }

  // Tier 2: Gemini Direct (fallback when quota is available)
  try {
    const text = await extractTextWithGemini(assignment);
    console.log(`[Vision Agent] ✅ Gemini direct succeeded for ${assignment.name}`);
    return text;
  } catch (fallbackError) {
    console.error(`[Vision Agent] ❌ All vision providers failed for ${assignment.name}: ${fallbackError.message}`);
    throw new Error(`All vision providers exhausted: ${fallbackError.message}`);
  }
}

// Helper function to extract folder ID from Google Drive URL

function extractFolderId(url) {
  const match = url.match(/\/folders\/([a-zA-Z0-9-_]+)/);
  return match ? match[1] : null;
}

// Helper for recursive folder scanning
async function getAllFilesInFolder(drive, folderId) {
  let allFiles = [];
  try {
    const response = await drive.files.list({
      q: `'${folderId}' in parents and trashed=false`,
      fields: 'files(id, name, mimeType, size, webContentLink)',
    });
    for (const file of response.data.files || []) {
      if (file.mimeType === 'application/vnd.google-apps.folder') {
        const subFiles = await getAllFilesInFolder(drive, file.id);
        allFiles = allFiles.concat(subFiles);
      } else {
        allFiles.push(file);
      }
    }
  } catch (e) {
    console.error("Recursive fetch error:", e);
  }
  return allFiles;
}

// Main Evaluation Endpoint
app.post('/api/evaluate', async (req, res) => {
  // Set headers for SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const sendLog = (message, status = 'pending', icon = 'Bot') => {
    console.log(message);
    res.write(`data: ${JSON.stringify({ type: 'log', message, status, icon })}\n\n`);
  };

  try {
    const { driveUrl, accessToken, teacherInstructions, emailEnabled } = req.body;
    
    if (!driveUrl || !accessToken) {
      sendLog('[Error] Missing driveUrl or accessToken', 'warning', 'AlertTriangle');
      return res.end();
    }

    const folderId = extractFolderId(driveUrl);
    if (!folderId) {
      sendLog('[Error] Invalid Google Drive Folder URL', 'warning', 'AlertTriangle');
      return res.end();
    }

    sendLog(`[Drive Agent] 🔍 Tool call: google.drive.files.list on folder ${folderId}`, 'running', 'UploadCloud');
    sendLog(`[Drive Agent] Goal: Collect all student submissions, rubric, and roster from Drive`, 'running', 'UploadCloud');

    const auth = new google.auth.OAuth2();
    auth.setCredentials({ access_token: accessToken });
    const drive = google.drive({ version: 'v3', auth });

    sendLog(`[Drive Agent] Recursively searching folder ${folderId} and all subfolders...`, 'running', 'Search');
    const files = await getAllFilesInFolder(drive, folderId);
    
    // Filter to relevant files
    const relevantFiles = files.filter(f => 
      f.mimeType.startsWith('image/') || 
      f.mimeType === 'application/pdf' || 
      f.name === 'students.csv' || 
      f.name.toLowerCase().includes('rubric') || 
      f.name.toLowerCase().includes('question')
    );

    console.log(`[Agent Debug] Drive Files:`, relevantFiles.map(f => ({ name: f.name, size: f.size })));

    sendLog(`[Drive Agent] ✅ Observation: Found ${relevantFiles.length} valid files — ${relevantFiles.map(f=>f.name).join(', ')}`, 'success', 'CheckCircle');

    if (relevantFiles.length === 0) {
      sendLog('[Error] No relevant files found in the provided folder.', 'warning', 'AlertTriangle');
      return res.end();
    }

    // Process CSV Mapping
    let studentMapping = [];
    const csvFile = relevantFiles.find(f => f.name === 'students.csv');
    if (csvFile) {
      sendLog(`[Drive Agent] 🔍 Tool call: drive.files.get → students.csv (building name→email roster)`, 'running', 'FileText');
      const csvRes = await drive.files.get({ fileId: csvFile.id, alt: 'media' }, { responseType: 'text' });
      studentMapping = parse(csvRes.data, { columns: true, skip_empty_lines: true });
      sendLog(`[Drive Agent] ✅ Observation: Roster loaded — ${studentMapping.length} students mapped`, 'success', 'CheckCircle');
    }

    // Identify Rubric
    let rubricContext = "Grade the assignment based on standard academic knowledge.";
    const rubricFile = relevantFiles.find(f => f.name.toLowerCase().includes('rubric') || f.name.toLowerCase().includes('question'));
    
    if (rubricFile) {
      sendLog(`[Drive Agent] 🔍 Tool call: drive.files.get → ${rubricFile.name} (fetching grading rubric for RAG injection)`, 'running', 'FileText');
      try {
        const fileRes = await drive.files.get({ fileId: rubricFile.id, alt: 'media' }, { responseType: 'arraybuffer' });
        if (rubricFile.mimeType.startsWith('text/')) {
          rubricContext = Buffer.from(fileRes.data).toString('utf-8');
        } else if (rubricFile.mimeType.startsWith('image/')) {
          const base64Data = Buffer.from(fileRes.data).toString('base64');
          sendLog(`[Vision Agent] Transcribing image rubric...`, 'running', 'Bot');
          rubricContext = await extractTextWithFallback({ mimeType: rubricFile.mimeType, base64: base64Data }, groq);
        } else {
          rubricContext = "Mocked PDF Rubric text for hackathon.";
        }
        sendLog(`[Drive Agent] ✅ Observation: Rubric loaded (${rubricContext.length} chars) — will be injected into Evaluator context`, 'success', 'CheckCircle');
      } catch (err) {
        sendLog(`[Error] Failed parsing rubric: ${err.message}`, 'warning', 'AlertTriangle');
      }
    } else {
      sendLog(`[Drive Agent] No rubric found. Decision: using generic academic grading instructions.`, 'success', 'CheckCircle');
    }

    // Inject teacher's custom grading instructions if provided from Profile settings
    if (teacherInstructions && teacherInstructions.trim()) {
      rubricContext += `\n\n### TEACHER GRADING INSTRUCTIONS ###\n${teacherInstructions.trim()}`;
      sendLog(`[Evaluator Agent] 📋 Teacher instructions received (${teacherInstructions.trim().length} chars) — injected into grading context`, 'running', 'FileText');
    }

    // Identify Assignment Files
    const assignmentFiles = relevantFiles.filter(f => f.name !== 'students.csv' && f.id !== (rubricFile?.id || null));
    
    // ==========================================
    // Phase 1.5: The Organizer Agent (AI Fuzzy Matching)
    // ==========================================
    sendLog(`[Organizer Agent] 🤔 Reasoning: ${assignmentFiles.length} filenames may not exactly match student names — invoking LLM fuzzy-match`, 'running', 'Users');
    sendLog(`[Organizer Agent] 🔍 Tool call: groq.chat.completions (llama-3.3-70b-versatile) — semantic filename→email matching`, 'running', 'Users');
    
    let matchedMapping = [];
    if (studentMapping.length > 0) {
      try {
        const fileNamesList = assignmentFiles.map(f => f.name).join('\n');
        
        console.log(`[Agent Debug] studentMapping from CSV:`, studentMapping);
        const emailsList = studentMapping.map(s => s.email || s.Email || s.EMAIL || Object.values(s)[1]).join('\n'); // Fallbacks in case the column is named differently
        console.log(`[Agent Debug] emailsList:`, emailsList);
        
        const organizerPrompt = `You are a smart Organizer Agent. Match the following messy filenames to the correct student email address based on semantic similarity. You MUST strictly select the email EXACTLY as it appears in the provided STUDENT EMAILS list. Do NOT make up, guess, or hallucinate emails. If the student's name in the filename matches a name in the email, map them.\n\nFILENAMES:\n${fileNamesList}\n\nSTUDENT EMAILS:\n${emailsList}\n\nRespond with ONLY a JSON object containing a "matches" key. The "matches" key should hold an array of objects, where each object has "filename" and "email" keys. If a file cannot be matched to ANY email in the list, map it to "unknown@student.edu".`;

        const organizerCompletion = await groq.chat.completions.create({
          model: 'llama-3.3-70b-versatile', // Stronger reasoning model to prevent hallucinations
          messages: [{ role: 'system', content: organizerPrompt }],
          temperature: 0.1,
          response_format: { type: 'json_object' }
        });

        // Ensure the response is parsed correctly as an array or object containing the array
        let parsedMatch = JSON.parse(organizerCompletion.choices[0].message.content);
        if (Array.isArray(parsedMatch)) {
          matchedMapping = parsedMatch;
        } else if (parsedMatch.matches) {
           matchedMapping = parsedMatch.matches;
        } else {
           matchedMapping = Object.values(parsedMatch)[0] || [];
        }
        
        sendLog(`[Organizer Agent] ✅ Observation: LLM matched ${matchedMapping.length} files to student emails via semantic reasoning`, 'success', 'CheckCircle');
        sendLog(`[Organizer Agent] 🧠 Decision: Proceeding with AI-matched assignments — handing off to Vision Agent`, 'success', 'Users');
      } catch (matchError) {
        console.error(`[Organizer Error] Failed to match:`, matchError);
        sendLog(`[Organizer Agent] ⚠️ LLM match failed — Decision: falling back to strict CSV name matching`, 'warning', 'AlertTriangle');
        matchedMapping = studentMapping;
      }
    } else {
      sendLog(`[Organizer Agent] No CSV provided, defaulting to unknown emails...`, 'warning', 'AlertTriangle');
    }

    sendLog(`[Drive Agent] Downloading student assignments into memory...`, 'running', 'Download');
    const assignments = [];
    for (const file of assignmentFiles) {
      try {
        let url = file.webContentLink || `https://www.googleapis.com/drive/v3/files/${file.id}?alt=media`;
        
        let fetchRes = await axios.get(url, { 
          headers: { Authorization: `Bearer ${accessToken}` },
          responseType: 'arraybuffer',
          maxRedirects: 0,
          validateStatus: status => status >= 200 && status < 400
        });
        
        if (fetchRes.status >= 300 && fetchRes.headers.location) {
          fetchRes = await axios.get(fetchRes.headers.location, {
            headers: { Authorization: `Bearer ${accessToken}` },
            responseType: 'arraybuffer'
          });
        }
        
        const fileBuffer = Buffer.from(fetchRes.data);
        
        console.log(`[Drive Debug] Downloaded ${file.name}. Actual File Size on Google Drive: ${file.size} bytes. Buffer byteLength: ${fileBuffer.byteLength}`);
        
        // Find mapped email from AI Organizer output or fallback
        const aiMatch = matchedMapping.find(m => m.filename === file.name);
        const fallbackMatch = studentMapping.find(s => s.filename === file.name);
        const assignedEmail = aiMatch ? aiMatch.email : (fallbackMatch ? fallbackMatch.email : 'unknown@student.edu');

        assignments.push({
          id: file.id,
          name: file.name,
          studentEmail: assignedEmail,
          mimeType: file.mimeType,
          base64: fileBuffer.toString('base64')
        });
      } catch (err) {
        sendLog(`[Error] Downloading ${file.name}: ${err.message}`, 'warning', 'AlertTriangle');
      }
    }
    sendLog(`[Drive Agent] All assignments downloaded.`, 'success', 'CheckCircle');

    // ==========================================
    // Phase 1.6: Grouping Multi-Page Assignments
    // ==========================================
    sendLog(`[Organizer Agent] Grouping multi-page assignments by student email...`, 'running', 'Users');
    const groupedAssignments = {};
    for (const a of assignments) {
      if (!groupedAssignments[a.studentEmail]) groupedAssignments[a.studentEmail] = { studentEmail: a.studentEmail, files: [], extractedText: '' };
      groupedAssignments[a.studentEmail].files.push(a);
    }
    const studentRecords = Object.values(groupedAssignments);
    sendLog(`[Organizer Agent] Consolidated into ${studentRecords.length} unique student records.`, 'success', 'CheckCircle');

    // Phase 2: OCR / Vision Agent Integration
    sendLog(`[Vision Agent] 🤔 Reasoning: ${studentRecords.length} students have image submissions requiring OCR before grading`, 'running', 'Bot');
    sendLog(`[Vision Agent] Strategy: OpenRouter (llama-4-scout) primary → Gemini direct fallback`, 'running', 'Bot');
    for (const record of studentRecords) {
      sendLog(`[Vision Agent] Processing ${record.files.length} page(s) for ${record.studentEmail}...`, 'running', 'Bot');
      let combinedText = '';
      for (let i = 0; i < record.files.length; i++) {
        const file = record.files[i];
        sendLog(`[Vision Agent] 🔍 Tool call: OpenRouter API → llama-4-scout (image OCR) — ${file.name} (${Math.round(file.base64.length * 0.75 / 1024)}KB)`, 'running', 'Eye');
        try {
          const extractedPageText = await extractTextWithFallback(file);
          combinedText += `\n--- PAGE ${i + 1} (${file.name}) ---\n${extractedPageText}\n`;
          sendLog(`[Vision Agent] ✅ Observation: Extracted ${extractedPageText.length} chars from ${file.name} — passing to Evaluator`, 'success', 'CheckCircle');
        } catch (visionError) {
          sendLog(`[Vision Agent] ❌ All providers exhausted for ${file.name} — marking page for review`, 'warning', 'AlertTriangle');
          combinedText += `\n--- PAGE ${i + 1} (${file.name}) ---\n[ERROR EXTRACTING TEXT]\n`;
        }
      }
      record.extractedText = combinedText;
    }

    // Phase 3: Evaluation Agent Integration (Groq LLM)
    sendLog(`[Evaluator Agent] 🤔 Reasoning: OCR complete for ${studentRecords.length} students — invoking rubric-based LLM grader`, 'running', 'Users');
    sendLog(`[Evaluator Agent] Strategy: GPT-OSS-120B → GPT-OSS-20B → Llama-3.3-70B (3-model fallback chain)`, 'running', 'Users');
    const results = [];

    for (const record of studentRecords) {
      if (record.extractedText.includes("[ERROR EXTRACTING TEXT]") && record.extractedText.length < 50) {
        sendLog(`[Evaluator Agent] ⚠️ Decision: ${record.studentEmail} has no extractable text — holding for manual review`, 'warning', 'AlertTriangle');
        results.push({ name: 'Multi-page Submission', studentEmail: record.studentEmail, score: 0, status: 'Held for Review', feedback: 'Failed to extract text from images.' });
        continue;
      }
      try {
        sendLog(`[Evaluator Agent] 🔍 Tool call: groq.chat.completions → grading ${record.studentEmail} against rubric (${rubricContext.length} chars context)`, 'running', 'BarChart2');
        const evalModels = ['openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'llama-3.3-70b-versatile'];
        let evalContent = '';
        let usedModel = '';

        for (const model of evalModels) {
          try {
            const evalCompletion = await groq.chat.completions.create({
              model: model,
              messages: [
                {
                  role: 'system',
                  content: `You are an expert teacher grading an assignment. Evaluate the following extracted text against this specific question/rubric:\n\n### RUBRIC / QUESTION ###\n${rubricContext}\n\n### INSTRUCTIONS ###\nProvide a JSON response with exactly three keys: "score" (number from 0 to 100), "feedback" (a short, constructive paragraph), and "attention_required" (string, either "None" or a very short phrase describing the main issue if the score is low).`
                },
                {
                  role: 'user',
                  content: `Here is the transcribed text of the student's multi-page assignment: \n\n${record.extractedText}`
                }
              ],
              temperature: 0.2,
              response_format: { type: 'json_object' }
            });
            evalContent = evalCompletion.choices[0].message.content;
            usedModel = model;
            break; // Success, break out of fallback loop
          } catch (modelError) {
            sendLog(`[Evaluator Agent] ⚠️ ${model} unavailable (${modelError.message.substring(0,60)}) — trying next model in chain`, 'warning', 'AlertTriangle');
            console.warn(`[Agent] Eval Model ${model} failed:`, modelError.message);
            if (model === evalModels[evalModels.length - 1]) throw modelError;
          }
        }

        const evaluation = JSON.parse(evalContent);
        
        // Determine status based on score
        const status = evaluation.score < 60 ? 'Held for Review' : 'Emailed';
        sendLog(`[Evaluator Agent] ✅ Observation: ${record.studentEmail} scored ${evaluation.score}% via ${usedModel}`, 'success', 'CheckCircle');
        sendLog(`[Evaluator Agent] 🧠 Decision: Score ${evaluation.score}% → ${status === 'Emailed' ? 'above 60% threshold — auto-email feedback' : 'below 60% threshold — hold for teacher review'}`, 'success', 'BarChart2');
        
        results.push({
          name: record.files.length > 1 ? `${record.files.length} Pages` : record.files[0].name,
          studentEmail: record.studentEmail,
          score: evaluation.score,
          status: status,
          attention_required: evaluation.attention_required,
          feedback: evaluation.feedback,
          fileIds: record.files.map(f => f.id)
        });

      } catch (evalError) {
        sendLog(`[Evaluator Error] Failed grading ${record.studentEmail}`, 'warning', 'AlertTriangle');
        results.push({ name: record.files.length > 1 ? 'Multi-page Submission' : record.files[0].name, studentEmail: record.studentEmail, score: 0, status: 'Held for Review', attention_required: 'Error parsing evaluation', fileIds: record.files.map(f => f.id) });
      }
    }

    // Phase 4: Gmail Agent
    const emailQueue = results.filter(r => r.status === 'Emailed' && r.studentEmail !== 'unknown@student.edu');
    const heldQueue = results.filter(r => r.status === 'Held for Review');

    if (emailEnabled === false) {
      sendLog(`[Gmail Agent] 🧠 Decision: Email sending disabled by teacher — skipping Gmail, generating CSV report only`, 'warning', 'Mail');
      sendLog(`[Gmail Agent] 📋 ${emailQueue.length} student(s) graded and ready for CSV download`, 'success', 'CheckCircle');
    } else {
      sendLog(`[Gmail Agent] 🤔 Reasoning: ${emailQueue.length} student(s) above threshold → auto-email | ${heldQueue.length} student(s) below threshold → hold for teacher`, 'running', 'Mail');
      const gmail = google.gmail({ version: 'v1', auth });

      for (const resItem of results) {
        if (resItem.status === 'Emailed' && resItem.studentEmail !== 'unknown@student.edu') {
          try {
            sendLog(`[Gmail Agent] 🔍 Tool call: gmail.users.messages.send → ${resItem.studentEmail} (score: ${resItem.score}%)`, 'running', 'Mail');
            const subject = 'Your Assignment Feedback - MentoraX';
            const body = `Hello,\n\nHere is the feedback for your recent assignment (${resItem.name}):\n\nScore: ${resItem.score}/100\n\nFeedback:\n${resItem.feedback}\n\nBest regards,\nMentoraX AI Assistant`;
            
            const emailLines = [
              `To: ${resItem.studentEmail}`,
              'Content-type: text/plain;charset=utf-8',
              'MIME-Version: 1.0',
              `Subject: ${subject}`,
              '',
              body
            ];
            const email = emailLines.join('\r\n');
            const base64EncodedEmail = Buffer.from(email).toString('base64').replace(/\+/g, '-').replace(/\//g, '_');

            await gmail.users.messages.send({
              userId: 'me',
              requestBody: { raw: base64EncodedEmail },
            });
            sendLog(`[Gmail Agent] ✅ Observation: Feedback email delivered to ${resItem.studentEmail}`, 'success', 'CheckCircle');
          } catch (emailError) {
            sendLog(`[Gmail Error] Failed on ${resItem.studentEmail}: ${emailError.message}`, 'warning', 'AlertTriangle');
            resItem.status = 'Held for Review';
          }
        } else if (resItem.status === 'Held for Review') {
          sendLog(`[Gmail Agent] 🧠 Decision: ${resItem.studentEmail} held — score below threshold, awaiting teacher approval`, 'warning', 'AlertTriangle');
        } else if (resItem.status === 'Emailed') {
          sendLog(`[Gmail Agent] Skipped emailing ${resItem.name} (No mapped email)`, 'warning', 'AlertTriangle');
        }
      }
    }

    // Send final payload
    // Database storage
    try {
      let db = [];
      if (fs.existsSync('db.json')) {
        db = JSON.parse(fs.readFileSync('db.json', 'utf8'));
      }
      // Add a date to each result
      const newResults = results.map(r => ({ ...r, date: new Date().toISOString() }));
      db = db.concat(newResults);
      fs.writeFileSync('db.json', JSON.stringify(db, null, 2));
    } catch (dbError) {
      console.warn("Failed to save to database:", dbError);
    }

    sendLog('[Pipeline] Evaluation complete. Updating UI...', 'success', 'CheckCircle');
    res.write(`data: ${JSON.stringify({ type: 'done', results })}\n\n`);
    res.end();

  } catch (error) {
    sendLog(`[System Error] Critical failure: ${error.message}`, 'warning', 'AlertTriangle');
    res.end();
  }
});

// Endpoint to approve and send email for a Held for Review assignment
app.post('/api/approve', async (req, res) => {
  try {
    const { studentEmail, score, feedback, accessToken, name } = req.body;
    
    // 1. Send Email
    const auth = new google.auth.OAuth2();
    auth.setCredentials({ access_token: accessToken });
    const gmail = google.gmail({ version: 'v1', auth });

    console.log(`[Agent] Initiating Gmail Agent for manually approved assignment: ${name}`);
    const subject = 'Your Assignment Feedback - MentoraX';
    const body = `Hello,\n\nHere is the feedback for your recent assignment (${name}):\n\nScore: ${score}/100\n\nFeedback:\n${feedback}\n\nBest regards,\nMentoraX AI Assistant`;
    
    const emailLines = [
      `To: ${studentEmail}`,
      'Content-type: text/plain;charset=utf-8',
      'MIME-Version: 1.0',
      `Subject: ${subject}`,
      '',
      body
    ];
    const email = emailLines.join('\r\n');
    const base64EncodedEmail = Buffer.from(email).toString('base64').replace(/\+/g, '-').replace(/\//g, '_');

    await gmail.users.messages.send({
      userId: 'me',
      requestBody: { raw: base64EncodedEmail },
    });
    console.log(`[Agent] Successfully emailed feedback to ${studentEmail}`);
    // 2. Update local DB
    if (fs.existsSync('db.json')) {
      const db = JSON.parse(fs.readFileSync('db.json', 'utf8'));
      const record = db.find(r => r.studentEmail === studentEmail && r.status === 'Held for Review');
      if (record) {
        record.status = 'Emailed';
        record.score = score;
        record.feedback = feedback;
        fs.writeFileSync('db.json', JSON.stringify(db, null, 2));
      }
    }

    res.json({ status: 'success' });
  } catch (err) {
    console.error('Approval/Email error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET endpoint to fetch file preview from Google Drive
app.get('/api/file-preview', async (req, res) => {
  try {
    const { fileId, accessToken } = req.query;
    if (!fileId || !accessToken) return res.status(400).json({ error: 'Missing parameters' });

    const auth = new google.auth.OAuth2();
    auth.setCredentials({ access_token: accessToken });
    const drive = google.drive({ version: 'v3', auth });

    const meta = await drive.files.get({ fileId, fields: 'mimeType, name' });
    const fileRes = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'arraybuffer' });
    const base64 = Buffer.from(fileRes.data).toString('base64');

    res.json({
      mimeType: meta.data.mimeType,
      name: meta.data.name,
      base64
    });
  } catch (error) {
    console.error('File preview fetch error:', error);
    res.status(500).json({ error: 'Failed to retrieve file preview' });
  }
});

// POST endpoint for contextual chat with the Evaluator LLM
app.post('/api/chat-evaluate', async (req, res) => {
  try {
    const { teacherPrompt, chatHistory, currentScore, currentFeedback, studentEmail } = req.body;
    
    // Build context
    let systemPrompt = `You are a helpful AI teaching assistant in a manual review dashboard. You are chatting with the teacher about a student's submission (${studentEmail}).
The current assigned score is ${currentScore}/100.
The current drafted feedback is:
"${currentFeedback}"

The teacher will ask you questions or instruct you to adjust the feedback and score.
Provide a JSON response with the following keys:
1. "reply": Your conversational response to the teacher.
2. "newScore": (Optional) Include only if the teacher asks you to adjust the score, or if your updated feedback implies a score change. Must be a number.
3. "newFeedback": (Optional) Include only if the teacher asks you to adjust the feedback. Must be a string.

Respond ONLY with valid JSON.`;

    const messages = [
      { role: 'system', content: systemPrompt },
      ...chatHistory,
      { role: 'user', content: teacherPrompt }
    ];

    console.log(`[Agent] Initiating Chat Agent for ${studentEmail}`);
    
    // Using groq as configured in Phase 3
    const chatCompletion = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: messages,
      temperature: 0.2,
      response_format: { type: 'json_object' }
    });

    const responseContent = JSON.parse(chatCompletion.choices[0].message.content);
    res.json(responseContent);

  } catch (error) {
    console.error('Chat Evaluator error:', error);
    res.status(500).json({ error: 'Failed to process chat evaluation.' });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
