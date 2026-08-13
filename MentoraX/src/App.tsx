import React, { useState, useEffect, useMemo, useRef } from 'react';
import { useGoogleLogin } from '@react-oauth/google';
import { Bot, FileText, CheckCircle, AlertTriangle, UploadCloud, Users, Mail, Play, Check, Home, Search, BarChart2, User, Download, X } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

type AgentStep = {
  id: number;
  text: string;
  status: 'pending' | 'running' | 'success' | 'warning';
  icon?: React.ReactNode;
};

type Tab = 'Home' | 'Search' | 'Stats' | 'Profile';

function App() {
  const [showSplash, setShowSplash] = useState(true);
  const [activeTab, setActiveTab] = useState<Tab>('Home');
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [accessToken, setAccessToken] = useState('');
  const [driveUrl, setDriveUrl] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [evalResults, setEvalResults] = useState<any[]>([]);
  const [dbStudents, setDbStudents] = useState<any[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedReviewResult, setSelectedReviewResult] = useState<any | null>(null);
  const [showGuidelinesModal, setShowGuidelinesModal] = useState(false);
  const [teacherRubric, setTeacherRubric] = useState('');
  const [emailEnabled, setEmailEnabled] = useState(true);
  const [previewData, setPreviewData] = useState<{base64: string, mimeType: string} | null>(null);
  const [isLoadingPreview, setIsLoadingPreview] = useState(false);
  
  // Chatbot states
  const [chatMessages, setChatMessages] = useState<{role: string, content: string}[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [isChatLoading, setIsChatLoading] = useState(false);

  const traceEndRef = useRef<HTMLDivElement>(null);
  
  // Fetch historical DB on mount
  useEffect(() => {
    fetch('http://localhost:3001/api/students')
      .then(res => res.json())
      .then(data => setDbStudents(data || []))
      .catch(err => console.error("Failed to load DB:", err));
  }, [activeTab]); // Refetch when tabs switch
  
  // Hide splash screen after 2 seconds
  useEffect(() => {
    const timer = setTimeout(() => {
      setShowSplash(false);
    }, 2000);
    return () => clearTimeout(timer);
  }, []);

  // Compute dynamic stats from evalResults
  const stats = useMemo(() => {
    if (evalResults.length === 0) return { avgScore: 0, weakest: 'N/A', atRisk: 0, topics: {} };
    
    let totalScore = 0;
    let atRisk = 0;
    const topicCounts: Record<string, number> = {};

    evalResults.forEach(r => {
      totalScore += r.score;
      if (r.score < 60) atRisk++;
      if (r.attention_required && r.attention_required !== 'None') {
        topicCounts[r.attention_required] = (topicCounts[r.attention_required] || 0) + 1;
      }
    });

    // Find weakest topic
    let weakest = 'None';
    let maxCount = 0;
    for (const [topic, count] of Object.entries(topicCounts)) {
      if (count > maxCount) {
        maxCount = count;
        weakest = topic;
      }
    }

    return {
      avgScore: Math.round(totalScore / evalResults.length),
      weakest: weakest,
      atRisk: atRisk,
      topics: topicCounts
    };
  }, [evalResults]);

  // State for the Live Agent Trace (Groq style)
  const [agentSteps, setAgentSteps] = useState<AgentStep[]>([]);
  
  // Auto-scroll Live Agent Trace
  useEffect(() => {
    if (traceEndRef.current) {
      traceEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [agentSteps]);

  // Fetch file preview when a review result is selected
  useEffect(() => {
    if (selectedReviewResult && selectedReviewResult.fileIds && selectedReviewResult.fileIds.length > 0 && accessToken) {
      setIsLoadingPreview(true);
      setPreviewData(null);
      // Fetch the first file's preview
      fetch(`http://localhost:3001/api/file-preview?fileId=${selectedReviewResult.fileIds[0]}&accessToken=${accessToken}`)
        .then(res => res.json())
        .then(data => {
          if (data && data.base64) {
            setPreviewData(data);
          }
          setIsLoadingPreview(false);
        })
        .catch(err => {
          console.error("Failed to load file preview:", err);
          setIsLoadingPreview(false);
        });
    } else {
      setPreviewData(null);
    }
  }, [selectedReviewResult, accessToken]);

  const handleChatSubmit = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!chatInput.trim() || !selectedReviewResult) return;
    
    const userMessage = { role: 'user', content: chatInput };
    const updatedHistory = [...chatMessages, userMessage];
    setChatMessages(updatedHistory);
    setChatInput('');
    setIsChatLoading(true);

    try {
      const response = await fetch('http://localhost:3001/api/chat-evaluate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          teacherPrompt: userMessage.content,
          chatHistory: chatMessages,
          currentScore: selectedReviewResult.score,
          currentFeedback: selectedReviewResult.feedback,
          studentEmail: selectedReviewResult.studentEmail
        })
      });

      const data = await response.json();
      
      setChatMessages(prev => [...prev, { role: 'assistant', content: data.reply }]);
      
      // Automatically update score and feedback if AI provided them
      if (data.newScore !== undefined || data.newFeedback !== undefined) {
        setSelectedReviewResult((prev: any) => ({
          ...prev,
          score: data.newScore !== undefined ? data.newScore : prev.score,
          feedback: data.newFeedback !== undefined ? data.newFeedback : prev.feedback
        }));
      }
    } catch (error) {
      console.error("Chat error:", error);
      setChatMessages(prev => [...prev, { role: 'assistant', content: 'Sorry, I encountered an error while trying to respond.' }]);
    } finally {
      setIsChatLoading(false);
    }
  };

  // Function to consume real-time SSE agent traces from the backend
  const startAgentPipeline = async () => {
    if (!driveUrl || !accessToken) return;
    setIsProcessing(true);
    setAgentSteps([]);
    setEvalResults([]);

    try {
      const response = await fetch('http://localhost:3001/api/evaluate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ driveUrl, accessToken, teacherInstructions: teacherRubric, emailEnabled })
      });

      if (!response.body) throw new Error('ReadableStream not supported');
      
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let done = false;
      let stepIdCounter = 1;

      while (!done) {
        const { value, done: readerDone } = await reader.read();
        done = readerDone;
        if (value) {
          const chunk = decoder.decode(value);
          const lines = chunk.split('\n\n');
          
          for (const line of lines) {
            if (line.startsWith('data: ')) {
              try {
                const data = JSON.parse(line.substring(6));
                
                if (data.type === 'log') {
                  setAgentSteps(prev => {
                    // Mark previous running steps as success
                    const updated = prev.map(s => s.status === 'running' ? { ...s, status: 'success' as const } : s);
                    
                    // Choose icon based on string
                    let IconComponent = Bot;
                    if (data.icon === 'UploadCloud') IconComponent = UploadCloud;
                    if (data.icon === 'Search') IconComponent = Search;
                    if (data.icon === 'CheckCircle') IconComponent = CheckCircle;
                    if (data.icon === 'AlertTriangle') IconComponent = AlertTriangle;
                    if (data.icon === 'FileText') IconComponent = FileText;
                    if (data.icon === 'Download') IconComponent = Download;
                    if (data.icon === 'Users') IconComponent = Users;
                    if (data.icon === 'BarChart2') IconComponent = BarChart2;
                    if (data.icon === 'Mail') IconComponent = Mail;
                    if (data.icon === 'Check') IconComponent = Check;

                    return [...updated, { 
                      id: stepIdCounter++, 
                      text: data.message, 
                      status: data.status as 'pending' | 'running' | 'success' | 'warning', 
                      icon: <IconComponent size={16} /> 
                    }];
                  });
                } else if (data.type === 'done') {
                  setEvalResults(data.results || []);
                  setIsProcessing(false);
                }
              } catch (err) {
                console.error("Error parsing SSE data:", err);
              }
            }
          }
        }
      }
    } catch (error) {
      console.error(error);
      setAgentSteps(prev => [...prev, { id: 999, text: 'Network Error connecting to backend.', status: 'warning', icon: <AlertTriangle size={16} /> }]);
      setIsProcessing(false);
    }
  };

  const handleApprove = async (result: any) => {
    try {
      const response = await fetch('http://localhost:3001/api/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          studentEmail: result.studentEmail, 
          score: result.score, 
          feedback: result.feedback, 
          accessToken, 
          name: result.name 
        })
      });
      const data = await response.json();
      if (data.status === 'success') {
        // Update local state to show Emailed
        setEvalResults(prev => prev.map(r => r.studentEmail === result.studentEmail ? { ...r, status: 'Emailed' } : r));
        setSelectedReviewResult(null); // Close modal
      } else {
        alert('Failed to send email: ' + data.error);
      }
    } catch (err) {
      alert('Network error approving email.');
    }
  };

  const handleLogout = () => {
    setIsAuthenticated(false);
    setAccessToken('');
    setEvalResults([]);
  };

  const login = useGoogleLogin({
    onSuccess: (tokenResponse) => {
      console.log('Login Success');
      setAccessToken(tokenResponse.access_token);
      setIsAuthenticated(true);
    },
    scope: 'https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/gmail.send',
    onError: () => console.error('Login Failed'),
  });

  return (
    <>
      <AnimatePresence>
        {showSplash && (
          <motion.div 
            className="fixed inset-0 z-50 flex items-center justify-center bg-[#0f172a]"
            initial={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.8, ease: "easeInOut" }}
          >
            <motion.h1 
              layoutId="logo"
              className="text-white drop-shadow-2xl m-0"
              style={{ fontSize: '6rem', background: 'linear-gradient(to right, #ffffff, #94a3b8)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', fontWeight: 'bold' }}
              transition={{ duration: 1.2, ease: [0.25, 1, 0.5, 1] }}
            >
              MentoraX
            </motion.h1>
          </motion.div>
        )}
      </AnimatePresence>



      <motion.div 
        className="container mt-4"
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 2, duration: 0.8 }}
      >
        <header className="flex justify-between items-center mb-16">
          {!showSplash ? (
            <motion.h1 
              layoutId="logo"
              transition={{ duration: 1.2, ease: [0.25, 1, 0.5, 1] }}
            >
              MentoraX
            </motion.h1>
          ) : (
            <h1 style={{ opacity: 0 }}>MentoraX</h1>
          )}

        {/* Floating Navigation Bar */}
        <motion.nav 
          className="floating-nav"
          initial={{ y: -100, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={{ delay: 1.8, duration: 0.8 }}
        >
          <button 
            className={`nav-item ${activeTab === 'Home' ? 'active' : ''}`}
            onClick={() => setActiveTab('Home')}
          >
            <Home size={20} className="icon" />
            {activeTab === 'Home' && <span>Home</span>}
          </button>
          <button 
            className={`nav-item ${activeTab === 'Search' ? 'active' : ''}`}
            onClick={() => setActiveTab('Search')}
          >
            <Search size={20} className="icon" />
            {activeTab === 'Search' && <span>Search</span>}
          </button>
          <button 
            className={`nav-item ${activeTab === 'Stats' ? 'active' : ''}`}
            onClick={() => setActiveTab('Stats')}
          >
            <BarChart2 size={20} className="icon" />
            {activeTab === 'Stats' && <span>Stats</span>}
          </button>
          <button 
            className={`nav-item ${activeTab === 'Profile' ? 'active' : ''}`}
            onClick={() => setActiveTab('Profile')}
          >
            <User size={20} className="icon" />
            {activeTab === 'Profile' && <span>Profile</span>}
          </button>
        </motion.nav>

        {/* Auth Button */}
        {!isAuthenticated ? (
          <button className="btn btn-primary" onClick={() => login()}>
            <UploadCloud size={20} />
            Sign in with Google
          </button>
        ) : (
          <div className="flex items-center gap-3">
            <span
              className="badge badge-success"
              style={{ fontSize: '0.7rem', letterSpacing: '0.05em' }}
            >
              ● Connected
            </span>
            <button
              onClick={handleLogout}
              title="Sign out"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '0.4rem',
                padding: '0.45rem 1rem',
                borderRadius: '9999px',
                background: 'rgba(255,255,255,0.06)',
                backdropFilter: 'blur(10px)',
                WebkitBackdropFilter: 'blur(10px)',
                border: '1px solid rgba(255,255,255,0.15)',
                color: '#94a3b8',
                fontSize: '0.8rem',
                fontWeight: 500,
                cursor: 'pointer',
                transition: 'all 0.2s ease',
              }}
              onMouseEnter={e => {
                const btn = e.currentTarget as HTMLButtonElement;
                btn.style.background = 'rgba(239,68,68,0.12)';
                btn.style.borderColor = 'rgba(239,68,68,0.35)';
                btn.style.color = '#fca5a5';
              }}
              onMouseLeave={e => {
                const btn = e.currentTarget as HTMLButtonElement;
                btn.style.background = 'rgba(255,255,255,0.06)';
                btn.style.borderColor = 'rgba(255,255,255,0.15)';
                btn.style.color = '#94a3b8';
              }}
            >
              <X size={13} />
              Sign out
            </button>
          </div>
        )}
      </header>

        {/* Main Content Area based on Active Tab */}
        <AnimatePresence mode="wait">
          <motion.div 
            key={activeTab}
            initial={{ opacity: 0, x: -20 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 20 }}
            transition={{ duration: 0.3 }}
            className="mt-12"
          >
            {activeTab === 'Home' && (
              <>
                <p className="mb-4 text-gray-300">Autonomous Assignment Review & Feedback System</p>

                <div className="grid grid-cols-3 gap-8">
                  {/* Left Column: Actions & Stats */}
                  <div className="flex flex-col gap-4">
                    <div className="glass-panel">
                      <h2>Process Assignments</h2>
                      <p className="mb-4 text-sm text-gray-400">Import student submissions from Google Drive.</p>
                      
                      <input 
                        type="text" 
                        placeholder="Paste Google Drive Folder URL..." 
                        className="input-field mb-4"
                        value={driveUrl}
                        onChange={(e) => setDriveUrl(e.target.value)}
                        disabled={!isAuthenticated || isProcessing}
                      />
                      
                      <button 
                        className="btn btn-primary w-full"
                        onClick={() => setShowGuidelinesModal(true)}
                        disabled={!isAuthenticated || !driveUrl || isProcessing}
                      >
                        {isProcessing ? <Bot className="animate-spin" /> : <Play size={18} />}
                        {isProcessing ? 'Agents Running...' : 'Start Evaluation'}
                      </button>
                      
                      {/* Email Toggle */}
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: '16px', padding: '12px 14px', borderRadius: '8px', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)' }}>
                        <div>
                          <p style={{ fontSize: '0.85rem', color: '#e2e8f0', fontWeight: 500, marginBottom: '2px' }}>Send Email to Students</p>
                          <p style={{ fontSize: '0.72rem', color: '#64748b' }}>{emailEnabled ? 'Feedback will be emailed automatically' : 'Only CSV report will be generated'}</p>
                        </div>
                        <button
                          onClick={() => setEmailEnabled(p => !p)}
                          style={{
                            width: '44px', height: '24px', borderRadius: '9999px', border: 'none', cursor: 'pointer',
                            background: emailEnabled ? 'rgba(255,255,255,0.25)' : 'rgba(255,255,255,0.1)',
                            position: 'relative', transition: 'background 0.25s ease', flexShrink: 0,
                          }}
                        >
                          <span style={{
                            position: 'absolute', top: '3px',
                            left: emailEnabled ? '22px' : '3px',
                            width: '18px', height: '18px', borderRadius: '50%',
                            background: emailEnabled ? '#ffffff' : '#475569',
                            transition: 'left 0.25s ease, background 0.25s ease',
                            display: 'block',
                          }} />
                        </button>
                      </div>

                      {/* CSV Download Button - shown after results */}
                      {evalResults.length > 0 && (
                        <button
                          onClick={() => {
                            const headers = ['Name', 'Student Email', 'Score', 'Status', 'Feedback', 'Date'];
                            const rows = evalResults.map(r => [
                              `"${(r.name || '').replace(/"/g, '""')}"`,
                              `"${(r.studentEmail || '').replace(/"/g, '""')}"`,
                              r.score,
                              `"${(r.status || '').replace(/"/g, '""')}"`,
                              `"${(r.feedback || '').replace(/"/g, '""').replace(/\n/g, ' ')}"`,
                              `"${new Date().toISOString().split('T')[0]}"`
                            ]);
                            const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
                            const blob = new Blob([csv], { type: 'text/csv' });
                            const url = URL.createObjectURL(blob);
                            const a = document.createElement('a');
                            a.href = url;
                            a.download = `MentoraX_Results_${new Date().toISOString().split('T')[0]}.csv`;
                            a.click();
                            URL.revokeObjectURL(url);
                          }}
                          className="btn btn-outline w-full mt-3"
                          style={{ gap: '8px', fontSize: '0.875rem' }}
                        >
                          <Download size={15} />
                          Download Results CSV
                        </button>
                      )}

                      {!isAuthenticated && (
                        <p className="text-sm mt-4 text-[#f87171]">
                          <AlertTriangle size={14} className="inline mr-1" />
                          Please sign in with Google first.
                        </p>
                      )}
                    </div>

                    <div className="glass-panel">
                      <h2>Class Overview</h2>
                      <div className="flex justify-between items-center mt-4 mb-2">
                        <span>Average Score</span>
                        <span className={`badge ${stats.avgScore > 75 ? 'badge-success' : stats.avgScore > 60 ? 'badge-warning' : 'badge-danger'}`}>
                          {evalResults.length > 0 ? `${stats.avgScore}%` : 'N/A'}
                        </span>
                      </div>
                      <div className="flex justify-between items-center mb-2">
                        <span>Weakest Topic</span>
                        <span className="badge badge-warning">{stats.weakest}</span>
                      </div>
                      <div className="flex justify-between items-center">
                        <span>At-Risk Students</span>
                        <span className={`badge ${stats.atRisk > 0 ? 'badge-danger' : 'badge-success'}`}>
                          {evalResults.length > 0 ? `${stats.atRisk} Students` : '0 Students'}
                        </span>
                      </div>
                    </div>
                  </div>

                  {/* Middle Column: Live Agent Trace (Groq Style) */}
                  <div className="glass-panel" style={{ gridColumn: 'span 2' }}>
                    <h2>Live Agent Trace</h2>
                    <p className="mb-4 text-sm text-gray-400">Watch the autonomous agents execute the evaluation pipeline.</p>
                    
                    <div 
                      className="flex flex-col gap-2 p-4 rounded-lg"
                      style={{ 
                        background: 'rgba(255, 255, 255, 0.03)', 
                        boxShadow: 'inset 0 2px 10px rgba(0,0,0,0.2)',
                        border: '1px solid rgba(255,255,255,0.05)',
                        minHeight: '300px', 
                        maxHeight: '400px',
                        overflowY: 'auto'
                      }}
                    >
                      {agentSteps.length === 0 && !isProcessing && (
                        <div className="flex h-full items-center justify-center text-[#94a3b8]">
                          Waiting for tasks...
                        </div>
                      )}
                      
                      {agentSteps.map((step) => (
                        <div key={step.id} className="flex items-start gap-4 p-3 rounded-lg animate-fade-in" style={{ 
                          background: 'rgba(255, 255, 255, 0.05)',
                          backdropFilter: 'blur(5px)',
                          border: '1px solid rgba(255,255,255,0.1)'
                        }}>
                          <div className={`mt-1 ${
                            step.status === 'success' ? 'text-green-400' : 
                            step.status === 'running' ? 'text-blue-400' : 
                            'text-gray-400'
                          }`}>
                            {step.icon}
                          </div>
                          <div className="flex-1">
                            <p className={step.status === 'success' ? 'text-gray-300' : 'text-white'}>
                              {step.text}
                            </p>
                            {step.status === 'running' && (
                              <div className="mt-2 h-1 w-24 bg-gray-700/50 rounded overflow-hidden">
                                <div className="h-full bg-blue-500/80 animate-pulse" style={{ width: '50%' }}></div>
                              </div>
                            )}
                          </div>
                        </div>
                      ))}
                      <div ref={traceEndRef} />
                    </div>
                  </div>
                </div>

                {/* Bottom Row: Results Table */}
                <div className="glass-panel mt-4 mb-10">
                  <h2>Recent Evaluations</h2>
                  <table className="w-full mt-4" style={{ textAlign: 'left', width: '100%' }}>
                    <thead>
                      <tr style={{ borderBottom: '1px solid var(--glass-border)' }}>
                        <th className="pb-2 text-gray-300">Student</th>
                        <th className="pb-2 text-gray-300">Score</th>
                        <th className="pb-2 text-gray-300">Status</th>
                        <th className="pb-2 text-gray-300">Attention Required</th>
                        <th className="pb-2 text-gray-300 text-right">Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {evalResults.length === 0 ? (
                        <tr>
                          <td colSpan={5} className="py-8 text-center text-gray-500">
                            No evaluations yet. Paste a Google Drive link and click Start Evaluation.
                          </td>
                        </tr>
                      ) : (
                        evalResults.map((result, idx) => (
                          <tr key={idx} style={{ borderTop: idx > 0 ? '1px solid var(--glass-border)' : 'none' }}>
                            <td className="py-3">{result.studentEmail}</td>
                            <td>{result.score}%</td>
                            <td>
                              {result.status === 'Emailed' ? (
                                <span className="badge badge-success">Emailed</span>
                              ) : (
                                <span className="badge badge-warning">Held for Review</span>
                              )}
                            </td>
                            <td className={result.attention_required !== 'None' ? 'text-yellow-400' : 'text-gray-400'}>
                              {result.attention_required || 'None'}
                            </td>
                            <td className="text-right">
                              {result.status === 'Held for Review' ? (
                                <button 
                                  onClick={() => setSelectedReviewResult(result)}
                                  className="btn btn-primary"
                                  style={{ padding: '4px 8px', fontSize: '12px' }}
                                >
                                  Review Draft
                                </button>
                              ) : (
                                <CheckCircle size={16} className="inline text-green-400 opacity-50" />
                              )}
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </>
            )}

            {activeTab === 'Search' && (
              <div className="glass-panel min-h-[500px]">
                <div className="flex justify-between items-center mb-6">
                  <h2>Student Database</h2>
                  <div className="flex gap-2 w-1/2">
                    <input 
                      type="text" 
                      placeholder="Search by name, email, or assignment..." 
                      className="input-field w-full" 
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                    />
                    <button className="btn btn-primary"><Search size={18} /></button>
                  </div>
                </div>
                
                {dbStudents.length === 0 ? (
                  <div className="flex h-[300px] items-center justify-center text-[#94a3b8] border border-dashed border-gray-600 rounded-lg">
                    Database is empty. Run an evaluation to populate it!
                  </div>
                ) : (
                  <div className="flex flex-col gap-3 max-h-[600px] overflow-y-auto pr-2">
                    {dbStudents
                      .filter(s => s.studentEmail.toLowerCase().includes(searchQuery.toLowerCase()))
                      .map((student, idx) => (
                      <div key={idx} className="flex justify-between items-center p-4 border border-gray-700/50 rounded-lg bg-gray-900/30 hover:bg-gray-800/50 transition-colors">
                        <div>
                          <h3 className="text-gray-200 font-medium">{student.studentEmail}</h3>
                          <p className="text-xs text-gray-500 mt-1">{new Date(student.date).toLocaleString()}</p>
                        </div>
                        <div className="flex items-center gap-4">
                          <div className={`px-3 py-1 rounded text-xs font-semibold ${student.score > 75 ? 'bg-green-500/20 text-green-400' : student.score > 60 ? 'bg-yellow-500/20 text-yellow-400' : 'bg-red-500/20 text-red-400'}`}>
                            {student.score}%
                          </div>
                          <button onClick={() => setSelectedReviewResult(student)} className="btn" style={{ padding: '4px 12px', fontSize: '12px', border: '1px solid rgba(255,255,255,0.1)' }}>
                            View Record
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {activeTab === 'Stats' && (
              <div className="grid grid-cols-2 gap-4">
                <div className="glass-panel min-h-[300px]">
                  <h2>Performance Distribution</h2>
                  <p className="text-gray-400 text-sm mb-4">Student scores across the latest batch.</p>
                  
                  {evalResults.length === 0 ? (
                    <div className="flex h-[200px] items-center justify-center border border-dashed border-gray-600 rounded-lg text-gray-400">
                      No data to display yet.
                    </div>
                  ) : (
                    <div className="flex items-end justify-around mt-8 border-b border-gray-600 pb-2 gap-4" style={{ height: '200px' }}>
                      {evalResults.map((result, idx) => {
                        const barHeight = Math.max((result.score / 100) * 180, 8);
                        const barColor = result.score > 75
                          ? 'linear-gradient(to top, #16a34a, #4ade80)'
                          : result.score > 60
                          ? 'linear-gradient(to top, #ca8a04, #facc15)'
                          : 'linear-gradient(to top, #dc2626, #f87171)';
                        return (
                          <div key={idx} className="flex flex-col items-center justify-end" style={{ flex: 1, height: '100%' }}>
                            <span className="text-xs font-bold mb-1" style={{ color: result.score > 75 ? '#4ade80' : result.score > 60 ? '#facc15' : '#f87171' }}>
                              {result.score}%
                            </span>
                            <div
                              style={{
                                width: '100%',
                                height: `${barHeight}px`,
                                background: barColor,
                                borderRadius: '6px 6px 0 0',
                                boxShadow: result.score > 75 ? '0 0 12px rgba(74,222,128,0.4)' : result.score > 60 ? '0 0 12px rgba(250,204,21,0.4)' : '0 0 12px rgba(248,113,113,0.4)',
                                transition: 'height 1s ease',
                              }}
                            />
                            <span className="text-xs text-gray-400 mt-2 truncate w-full text-center" title={result.studentEmail}>
                              {result.studentEmail.split('@')[0]}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
                
                <div className="glass-panel min-h-[300px]">
                  <h2>Common Weaknesses</h2>
                  <p className="text-gray-400 text-sm mb-4">Topics frequently flagged for attention.</p>
                  
                  {Object.keys(stats.topics).length === 0 ? (
                    <div className="flex h-[200px] items-center justify-center border border-dashed border-gray-600 rounded-lg text-gray-400">
                      No weaknesses flagged yet.
                    </div>
                  ) : (
                    <div className="flex flex-col gap-4 mt-8">
                      {Object.entries(stats.topics).map(([topic, count], idx) => (
                        <div key={idx} className="w-full">
                          <div className="flex justify-between text-sm mb-1">
                            <span className="text-gray-300">{topic}</span>
                            <span className="text-gray-400">{count} occurrences</span>
                          </div>
                          <div className="w-full bg-gray-700/50 rounded-full h-2">
                            <div className="bg-orange-500 h-2 rounded-full" style={{ width: `${Math.min((count as number / evalResults.length) * 100, 100)}%` }}></div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}

            {activeTab === 'Profile' && (
              <div className="glass-panel max-w-2xl mx-auto">
                <div className="flex items-center gap-4 mb-8">
                  <div className="w-16 h-16 rounded-full bg-gray-700 flex items-center justify-center">
                    <User size={32} />
                  </div>
                  <div>
                    <h2>Teacher Settings</h2>
                    <p className="text-gray-400">Manage your MentoraX preferences.</p>
                  </div>
                </div>
                
                <div className="flex flex-col gap-4">
                  <div>
                    <label className="block text-sm text-gray-300 mb-1">Google Account</label>
                    <div className="flex gap-2">
                      <input type="text" value={isAuthenticated ? "Connected via OAuth" : "Not Connected"} disabled className="input-field w-full opacity-70" />
                    </div>
                  </div>
                  <div>
                    <label className="block text-sm text-gray-300 mb-2">
                      Grading Instructions
                      <span style={{ marginLeft: '8px', fontSize: '0.7rem', color: '#64748b', fontWeight: 400 }}>
                        (optional — guides the AI evaluator)
                      </span>
                    </label>
                    <textarea
                      rows={6}
                      className="input-field w-full"
                      placeholder={"e.g.\n• Award 40 marks for correct methodology\n• Award 30 marks for accurate calculations\n• Award 30 marks for presentation and conclusion\n• Deduct marks for incomplete answers"}
                      value={teacherRubric}
                      onChange={e => setTeacherRubric(e.target.value)}
                      style={{ resize: 'vertical', lineHeight: 1.6 }}
                    />
                    <p style={{ fontSize: '0.75rem', color: '#475569', marginTop: '6px' }}>
                      {teacherRubric
                        ? '✅ These instructions will be sent to the Evaluator Agent when you run the pipeline.'
                        : 'If left empty, the AI will grade using the rubric file from your Drive folder (or default academic standards).'}
                    </p>
                  </div>
                </div>
              </div>
            )}
          </motion.div>
        </AnimatePresence>
      </motion.div>

      {/* Pre-flight Guidelines Modal */}
      <AnimatePresence>
        {showGuidelinesModal && (
          <motion.div 
            style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(5px)', zIndex: 100 }}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            <motion.div 
              className="glass-panel"
              style={{ width: '100%', maxWidth: '600px', margin: '0 20px', position: 'relative' }}
              initial={{ scale: 0.9, y: 20 }}
              animate={{ scale: 1, y: 0 }}
              exit={{ scale: 0.9, y: 20 }}
            >
              <button 
                onClick={() => setShowGuidelinesModal(false)}
                style={{ position: 'absolute', top: '20px', right: '20px', background: 'none', border: 'none', color: '#94a3b8', cursor: 'pointer' }}
              >
                <X size={24} />
              </button>
              
              <h2 style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
                <CheckCircle style={{ color: '#60a5fa' }} /> Pre-Flight Checklist
              </h2>
              <p style={{ color: '#94a3b8', fontSize: '14px', marginBottom: '24px' }}>Before you run the autonomous agents, ensure your Google Drive folder is structured correctly.</p>
              
              <div style={{ backgroundColor: 'rgba(15, 23, 42, 0.5)', borderRadius: '8px', padding: '24px', marginBottom: '24px', border: '1px solid rgba(255,255,255,0.1)' }}>
                <ol style={{ paddingLeft: '20px', margin: 0, color: '#e2e8f0', fontSize: '14px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
                  <li>
                    <strong>Master Folder:</strong> Ensure the Google Drive folder's sharing settings are set to <span style={{ color: '#60a5fa' }}>"Anyone with the link can view"</span>.
                  </li>
                  <li>
                    <strong>Grading Rubric:</strong> Include exactly one file that contains the grading criteria. The filename must contain the word <code style={{ backgroundColor: 'rgba(0,0,0,0.5)', padding: '2px 6px', borderRadius: '4px' }}>rubric</code> or <code style={{ backgroundColor: 'rgba(0,0,0,0.5)', padding: '2px 6px', borderRadius: '4px' }}>question</code>.
                  </li>
                  <li>
                    <strong>Student Submissions:</strong> Upload handwritten assignments as images. Messy structure is fine; the AI will find them!
                  </li>
                  <li>
                    <strong>Student Roster (Optional):</strong> Upload a <code style={{ backgroundColor: 'rgba(0,0,0,0.5)', padding: '2px 6px', borderRadius: '4px' }}>students.csv</code> with <code style={{ backgroundColor: 'rgba(0,0,0,0.5)', padding: '2px 6px', borderRadius: '4px' }}>filename</code> and <code style={{ backgroundColor: 'rgba(0,0,0,0.5)', padding: '2px 6px', borderRadius: '4px' }}>email</code> columns so the AI can fuzzy-match messy filenames to real emails.
                  </li>
                </ol>
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '12px' }}>
                <button 
                  onClick={() => setShowGuidelinesModal(false)}
                  className="btn"
                  style={{ backgroundColor: 'transparent', border: '1px solid rgba(255,255,255,0.2)', color: '#e2e8f0' }}
                >
                  Cancel
                </button>
                <button 
                  onClick={() => {
                    setShowGuidelinesModal(false);
                    startAgentPipeline();
                  }}
                  className="btn btn-primary"
                  style={{ display: 'flex', alignItems: 'center', gap: '8px' }}
                >
                  <Play size={18} />
                  Continue & Run Agents
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Draft Review Modal */}
      <AnimatePresence>
        {selectedReviewResult && (
          <motion.div 
            style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(5px)', zIndex: 100 }}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            <motion.div 
              className="glass-panel"
              style={{ width: '100%', maxWidth: '1000px', margin: '0 20px', position: 'relative', display: 'flex', flexDirection: 'column', maxHeight: '90vh' }}
              initial={{ scale: 0.9, y: 20 }}
              animate={{ scale: 1, y: 0 }}
              exit={{ scale: 0.9, y: 20 }}
            >
              <button 
                onClick={() => setSelectedReviewResult(null)}
                style={{ position: 'absolute', top: '20px', right: '20px', background: 'none', border: 'none', color: '#94a3b8', cursor: 'pointer', zIndex: 10 }}
              >
                <X size={24} />
              </button>
              
              <h2 style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
                <Mail style={{ color: '#60a5fa' }} /> Manual Review Required
              </h2>
              <p style={{ color: '#94a3b8', fontSize: '14px', marginBottom: '24px' }}>Compare the original submission with the AI evaluation before approving.</p>
              
              <div style={{ display: 'flex', gap: '24px', flex: 1, minHeight: 0, overflow: 'hidden' }}>
                {/* Left Column: Image Preview */}
                <div style={{ flex: 1, backgroundColor: 'rgba(15, 23, 42, 0.5)', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.1)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
                  <div style={{ padding: '12px 16px', borderBottom: '1px solid rgba(255,255,255,0.1)', backgroundColor: 'rgba(30, 41, 59, 0.5)', fontSize: '13px', fontWeight: 600, color: '#e2e8f0' }}>
                    Student Submission
                  </div>
                  <div style={{ flex: 1, overflow: 'auto', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px', position: 'relative' }}>
                    {isLoadingPreview ? (
                      <div className="flex flex-col items-center text-gray-400">
                        <div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin mb-4"></div>
                        <p className="text-sm">Fetching from Google Drive...</p>
                      </div>
                    ) : previewData ? (
                      previewData.mimeType === 'application/pdf' ? (
                        <embed src={`data:application/pdf;base64,${previewData.base64}`} type="application/pdf" width="100%" height="100%" style={{ minHeight: '400px', borderRadius: '4px' }} />
                      ) : (
                        <img src={`data:${previewData.mimeType};base64,${previewData.base64}`} alt="Student Submission" style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', borderRadius: '4px' }} />
                      )
                    ) : (
                      <div className="text-gray-500 text-sm flex flex-col items-center">
                        <AlertTriangle size={32} className="mb-2 opacity-50" />
                        <p>Preview unavailable. File might be missing or unsupported.</p>
                      </div>
                    )}
                  </div>
                </div>

                {/* Right Column: Feedback & Controls */}
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflowY: 'auto' }}>
                  <div style={{ backgroundColor: 'rgba(15, 23, 42, 0.5)', borderRadius: '8px', padding: '16px', marginBottom: '24px', border: '1px solid rgba(255,255,255,0.1)' }}>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', marginBottom: '16px', fontSize: '14px' }}>
                      <div>
                        <span style={{ color: '#64748b', display: 'block', fontSize: '12px', textTransform: 'uppercase', letterSpacing: '1px', marginBottom: '4px' }}>To (Student Email)</span>
                        <span style={{ color: '#fff', fontWeight: 500 }}>{selectedReviewResult.studentEmail}</span>
                      </div>
                      <div>
                        <span style={{ color: '#64748b', display: 'block', fontSize: '12px', textTransform: 'uppercase', letterSpacing: '1px', marginBottom: '4px' }}>Assessed Score</span>
                        <span style={{ fontWeight: 'bold', color: selectedReviewResult.score >= 60 ? '#4ade80' : '#f87171' }}>
                          {selectedReviewResult.score}%
                        </span>
                      </div>
                    </div>
                    
                    <div style={{ marginTop: '16px' }}>
                      <span style={{ color: '#64748b', display: 'block', fontSize: '12px', textTransform: 'uppercase', letterSpacing: '1px', marginBottom: '8px' }}>Drafted Feedback (Editable)</span>
                      <textarea 
                        style={{ width: '100%', minHeight: '120px', backgroundColor: 'rgba(30, 41, 59, 0.8)', padding: '16px', borderRadius: '4px', color: '#cbd5e1', fontSize: '14px', lineHeight: '1.6', border: '1px solid rgba(255,255,255,0.1)', resize: 'vertical' }}
                        value={selectedReviewResult.feedback}
                        onChange={(e) => setSelectedReviewResult({...selectedReviewResult, feedback: e.target.value})}
                      />
                    </div>
                  </div>

                  {/* Contextual AI Chat */}
                  <div style={{ backgroundColor: 'rgba(15, 23, 42, 0.5)', borderRadius: '8px', padding: '16px', display: 'flex', flexDirection: 'column', flex: 1, minHeight: '200px', border: '1px solid rgba(255,255,255,0.1)' }}>
                    <span style={{ color: '#64748b', display: 'block', fontSize: '12px', textTransform: 'uppercase', letterSpacing: '1px', marginBottom: '8px' }}>
                      <Bot size={14} style={{display:'inline', marginRight: '4px'}}/> Ask AI Assistant
                    </span>
                    
                    <div style={{ flex: 1, overflowY: 'auto', marginBottom: '12px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                      {chatMessages.length === 0 ? (
                         <div style={{ color: '#475569', fontSize: '13px', fontStyle: 'italic', textAlign: 'center', marginTop: '20px' }}>Ask me to explain the grade or modify the feedback...</div>
                      ) : (
                        chatMessages.map((msg, i) => (
                          <div key={i} style={{ alignSelf: msg.role === 'user' ? 'flex-end' : 'flex-start', backgroundColor: msg.role === 'user' ? 'rgba(59, 130, 246, 0.2)' : 'rgba(30, 41, 59, 0.8)', padding: '8px 12px', borderRadius: '8px', maxWidth: '90%', fontSize: '13px', color: '#e2e8f0', border: '1px solid rgba(255,255,255,0.05)' }}>
                            {msg.content}
                          </div>
                        ))
                      )}
                      {isChatLoading && (
                        <div style={{ alignSelf: 'flex-start', backgroundColor: 'rgba(30, 41, 59, 0.8)', padding: '8px 12px', borderRadius: '8px', fontSize: '13px', color: '#94a3b8' }}>
                          <span className="animate-pulse">Thinking...</span>
                        </div>
                      )}
                    </div>
                    
                    <form onSubmit={handleChatSubmit} style={{ display: 'flex', gap: '8px', marginTop: 'auto' }}>
                      <input 
                        type="text" 
                        placeholder="e.g., Be more encouraging in the feedback..." 
                        value={chatInput}
                        onChange={(e) => setChatInput(e.target.value)}
                        style={{ flex: 1, backgroundColor: 'rgba(15, 23, 42, 0.8)', border: '1px solid rgba(255,255,255,0.2)', borderRadius: '4px', padding: '8px 12px', color: '#fff', fontSize: '13px' }}
                      />
                      <button type="submit" disabled={isChatLoading || !chatInput.trim()} style={{ backgroundColor: 'rgba(59, 130, 246, 0.8)', border: 'none', borderRadius: '4px', padding: '0 12px', color: '#fff', cursor: isChatLoading ? 'not-allowed' : 'pointer', fontWeight: 600 }}>
                        Send
                      </button>
                    </form>
                  </div>

                  <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '12px', marginTop: 'auto' }}>
                    <button 
                      onClick={() => setSelectedReviewResult(null)}
                      className="btn"
                      style={{ backgroundColor: 'transparent', border: '1px solid rgba(255,255,255,0.2)', color: '#e2e8f0' }}
                    >
                      Cancel
                    </button>
                    <button 
                      onClick={() => handleApprove(selectedReviewResult)}
                      className="btn btn-primary"
                      style={{ display: 'flex', alignItems: 'center', gap: '8px' }}
                    >
                      <UploadCloud size={18} />
                      Approve & Send Email
                    </button>
                  </div>
                </div>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}

export default App;
