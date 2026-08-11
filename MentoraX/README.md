# MentoraX 🚀

## Team Name
[MentoraX]

## Team Members
- [Irine Milton]
- [𝙰lan 𝙹aison ]
- [Navaneeth kr]

---

## 🎯 Problem Statement
Teachers spend significant time collecting, evaluating, and providing feedback on student assignments submitted in different formats such as PDFs, images, handwritten answers, and code. Manual grading, identifying learning gaps, communicating results, and following up on improvements are repetitive and difficult to scale.

## 💡 Solution
**MentoraX** is an intelligent, multi-agent automated grading pipeline. It seamlessly connects to Google Drive to fetch student submissions, uses advanced Vision AI to transcribe handwritten text, intelligently maps files to students via semantic reasoning, grades the assignments against a provided rubric, and automatically dispatches the results via email.

---

## ✨ Features
- **Drive Agent:** Automatically connects to Google Drive via OAuth to recursively fetch student assignments, rubrics, and CSV rosters.
- **Organizer Agent:** Uses semantic reasoning (Groq Llama 3) to fuzzy-match messy, misspelled student filenames to their correct email addresses from the CSV.
- **Vision Agent:** Processes handwritten image submissions using Gemini Flash Vision to extract text with high accuracy.
- **Evaluator Agent:** Grades the transcribed submissions against the teacher's rubric using a massive reasoning model and assigns a score.
- **Gmail Agent:** Automatically dispatches the final grades and feedback to the students.
- **Real-time UI:** A beautiful React frontend that visualizes the AI agents working in real-time.

---

## 🤖 Agent Workflow / Flowchart
1. **Trigger:** User clicks "Start Evaluation" on the frontend.
2. **Fetch:** Drive Agent downloads `students.csv`, `rubric.txt`, and handwritten `.jpg` assignments.
3. **Organize:** Organizer Agent maps the messy image filenames to the exact student emails.
4. **Transcribe:** Vision Agent converts the handwritten images to digital text.
5. **Grade:** Evaluator Agent grades the text based on the rubric.
6. **Notify:** Gmail Agent emails the final grades to the students.

---

## 🏗️ Agent Architecture
MentoraX uses a custom, event-driven agentic architecture. Agents operate sequentially in a pipeline on a Node.js backend. As each agent completes its task, it streams real-time Server-Sent Events (SSE) to the React frontend to update the UI dynamically.

---

## 💻 Tech Stack
- **Frontend:** React, TypeScript, Vite, Tailwind CSS, Lucide Icons
- **Backend:** Node.js, Express, Server-Sent Events (SSE)
- **AI / LLM:** 
  - Google Gemini Flash (Vision / Handwriting Extraction)
  - Groq Llama-3.3-70B-Versatile (Semantic Mapping & Reasoning)
- **Agent Framework:** Custom Event-Driven Pipeline
- **Tools / APIs:** Google Drive API (OAuth 2.0), Google Generative AI SDK, Groq SDK
- **Database:** In-memory mapping via CSV parsing

---

## 🚀 Setup / How to Run

### Prerequisites
- Node.js installed
- `.env` file configured with `GEMINI_API_KEY` and `GROQ_API_KEY`

### 1. Start the Backend
```bash
cd server
npm install
npm start
```

### 2. Start the Frontend
Open a new terminal window:
```bash
npm install
npm run dev
```

---

## 🔗 Links
- **Repository Link:** [Insert GitHub Link Here]
- **Demo Link:** [Insert Video/Live Demo Link Here]
