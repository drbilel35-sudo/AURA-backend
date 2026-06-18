const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static('public'));

// Environment variables (Cleaned up globally once)
const RAW_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_API_KEY = RAW_KEY.trim().replace(/["']/g, '');

// Debug: Check if API key is loaded
console.log('=== API KEY DEBUG ===');
console.log('Has API Key?', !!GEMINI_API_KEY);
if (GEMINI_API_KEY) {
    console.log('Key length:', GEMINI_API_KEY.length);
    console.log('First 10 chars:', GEMINI_API_KEY.substring(0, 10));
}
console.log('===================');

// Fixed working model - utilizing stable production string names
const WORKING_MODEL = "gemini-2.5-flash"; 
let API_LLM_URL = null;
let API_READY = false;

// Function to test if the specified model works
async function testModel() {
    if (!GEMINI_API_KEY) {
        console.log('❌ No API key available');
        return false;
    }
    
    console.log(`\n🔍 Testing model: ${WORKING_MODEL}`);
    
    try {
        const testPayload = {
            contents: [{ 
                parts: [{ text: "Say 'working' in one word" }] 
            }],
            generationConfig: { 
                maxOutputTokens: 5,
                temperature: 0.1
            }
        };
        
        const response = await fetch(API_LLM_URL, {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json',
                'x-goog-api-key': GEMINI_API_KEY,
                'Connection': 'close'
            },
            body: JSON.stringify(testPayload)
        });
        
        if (response.ok) {
            const data = await response.json();
            console.log(`   ✅ Model ${WORKING_MODEL} is working seamlessly.`);
            return true;
        } else {
            const errorText = await response.text();
            let errorMsg = errorText;
            try {
                const errorJson = JSON.parse(errorText);
                errorMsg = errorJson.error?.message || errorText;
            } catch(e) {}
            
            console.log(`   ❌ Model ${WORKING_MODEL} failed: ${response.status} - ${errorMsg}`);
            return false;
        }
    } catch (error) {
        console.log(`   ❌ Error testing model: ${error.message}`);
        return false;
    }
}

// Initialize the model paths
async function initializeModels() {
    console.log('\n🔧 Initializing AURA AI model configurations...');
    
    // Abstracting endpoints safely away from inline query param string configurations
    API_LLM_URL = `https://generativelanguage.googleapis.com/v1beta/models/${WORKING_MODEL}:generateContent`;
    
    const isWorking = await testModel();
    
    if (isWorking) {
        API_READY = true;
        console.log(`\n🚀 AURA AI initialized cleanly with: ${WORKING_MODEL}`);
        return true;
    } else {
        API_READY = false;
        console.log(`\n❌ Failed to initialize model: ${WORKING_MODEL}`);
        return false;
    }
}

// Helper function for API calls with built-in backoff-retry logic
async function fetchWithRetry(url, payload, maxRetries = 3) {
    if (!GEMINI_API_KEY) {
        throw new Error('GEMINI_API_KEY is not set in environment variables');
    }
    
    if (!url) {
        throw new Error('API URL not initialized.');
    }
    
    let retries = 0;
    
    while (retries < maxRetries) {
        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: { 
                    'Content-Type': 'application/json',
                    'x-goog-api-key': GEMINI_API_KEY,
                    'Connection': 'close' // Fixes premature chunk closes by preventing pooling timeouts
                },
                body: JSON.stringify(payload)
            });

            if (response.ok) {
                return await response.json();
            } else {
                const errorText = await response.text();
                let errorDetail = errorText;
                try {
                    const errorJson = JSON.parse(errorText);
                    errorDetail = errorJson.error?.message || errorText;
                } catch(e) {}
                
                if (response.status === 429 || response.status >= 500) {
                    retries++;
                    const delay = 1000 * Math.pow(2, retries);
                    console.log(`   Retry ${retries}/${maxRetries} in ${delay}ms...`);
                    await new Promise(resolve => setTimeout(resolve, delay));
                } else {
                    throw new Error(`API returned status ${response.status}: ${errorDetail}`);
                }
            }
        } catch (error) {
            if (error.message.includes('API returned status')) throw error;
            retries++;
            if (retries >= maxRetries) throw error;
            const delay = 1000 * Math.pow(2, retries);
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
    throw new Error("All retry attempts failed");
}

// Text & Multimodal Chat Endpoint
app.post('/api/chat', async (req, res) => {
    try {
        const { message, imageData } = req.body;

        if (!message) {
            return res.status(400).json({ success: false, error: 'Message is required' });
        }

        if (!API_READY || !API_LLM_URL) {
            return res.status(503).json({ success: false, error: 'Model not initialized.' });
        }

        console.log(`📨 User Prompt: "${message.substring(0, 50)}..."`);

        // Important: Text prompts and images live contextually inside the SAME parts array element block
        const parts = [{ text: message }];
        
        if (imageData) {
            // Stripping headers if frontend sends data URL prefixes (e.g. data:image/jpeg;base64,)
            const cleanBase64 = imageData.includes(',') ? imageData.split(',')[1] : imageData;
            parts.push({
                inlineData: {
                    mimeType: "image/jpeg",
                    data: cleanBase64
                }
            });
        }

        const chatHistory = [{ role: "user", parts: parts }];

        const llmPayload = {
            contents: chatHistory,
            systemInstruction: { 
                parts: [{ 
                    text: "You are AURA, an advanced AI Humanoid Assistant. Before your response, you MUST prepend an emotion tag. Choose from: [EMOTION: NEUTRAL], [EMOTION: JOY], [EMOTION: INTEREST], or [EMOTION: CONFUSION]." 
                }] 
            },
            generationConfig: {
                temperature: 0.7,
                maxOutputTokens: 2048,
                topK: 40,
                topP: 0.95
            }
        };

        console.log('🔄 Routing to Gemini Engine...');
        const responseData = await fetchWithRetry(API_LLM_URL, llmPayload);
        const candidate = responseData.candidates?.[0];

        if (!candidate) throw new Error("Invalid response structure from LLM");

        const generatedText = candidate.content?.parts?.[0]?.text;
        if (!generatedText) throw new Error("No text content returned from engine models");

        const emotionMatch = generatedText.match(/\[EMOTION: (NEUTRAL|JOY|INTEREST|CONFUSION)\]/i);
        const emotion = emotionMatch ? emotionMatch[1].toUpperCase() : 'NEUTRAL';
        const cleanText = generatedText.replace(/\[EMOTION: (NEUTRAL|JOY|INTEREST|CONFUSION)\]/i, '').trim();

        res.json({
            success: true,
            text: cleanText,
            emotion: emotion,
            hasImage: !!imageData,
            model: WORKING_MODEL
        });

    } catch (error) {
        console.error('❌ Chat API Error:', error);
        res.status(500).json({ success: false, error: error.message || 'Internal server error' });
    }
});

// TTS Mock Endpoint 
app.post('/api/tts', async (req, res) => {
    try {
        const { text } = req.body;
        if (!text) return res.status(400).json({ success: false, error: 'Text is required for TTS' });
        res.json({ success: true, audioData: null, mimeType: 'audio/wav' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Health check endpoint
app.get('/api/health', (req, res) => {
    res.json({ 
        status: 'OK', 
        timestamp: new Date().toISOString(),
        hasApiKey: !!GEMINI_API_KEY,
        workingModel: WORKING_MODEL,
        isReady: API_READY
    });
});

// Debug / Troubleshooting dashboard validation
app.get('/api/test', async (req, res) => {
    try {
        if (!GEMINI_API_KEY) {
            return res.status(400).json({ error: 'API key not set inside execution env context' });
        }
        
        const testPayload = {
            contents: [{ parts: [{ text: "Hello" }] }]
        };
        
        const testResponse = await fetch(API_LLM_URL, {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json',
                'x-goog-api-key': GEMINI_API_KEY,
                'Connection': 'close'
            },
            body: JSON.stringify(testPayload)
        });
        
        const testData = await testResponse.json();
        
        res.json({
            status: 'Live Test Diagnosis',
            apiKeyLoaded: !!GEMINI_API_KEY,
            workingModel: WORKING_MODEL,
            responseStatus: testResponse.status,
            data: testData
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/', (req, res) => {
    res.sendFile(__dirname + '/public/index.html');
});

// Start application listener
app.listen(PORT, async () => {
    console.log(`\n🚀 AURA Backend Server operational on port ${PORT}`);
    if (GEMINI_API_KEY) {
        await initializeModels();
    } else {
        console.log('\n⚠️ WARNING: Missing initialization parameters inside active process shell variables.');
    }
});

process.on('SIGTERM', () => {
    console.log('Gracefully terminating daemon processing lines...');
    process.exit(0);
});
