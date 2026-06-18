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

// Environment variables
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// Debug: Check if API key is loaded
console.log('=== API KEY DEBUG ===');
console.log('Has API Key?', !!GEMINI_API_KEY);
if (GEMINI_API_KEY) {
    console.log('Key length:', GEMINI_API_KEY.length);
    console.log('First 10 chars:', GEMINI_API_KEY.substring(0, 10));
}
console.log('===================');

// Global variable for working model - FIXED to use gemini-2.5-flash
const WORKING_MODEL = "gemini-2.5-flash";
let API_LLM_URL = null;
let API_TTS_URL = null;
let API_READY = false;

// Function to test if the specified model works
async function testModel() {
    if (!GEMINI_API_KEY) {
        console.log('❌ No API key available');
        return false;
    }

    const cleanApiKey = GEMINI_API_KEY.trim().replace(/["']/g, '');
    
    console.log(`\n🔍 Testing model: ${WORKING_MODEL}`);
    
    try {
        const testUrl = `https://generativelanguage.googleapis.com/v1beta/models/${WORKING_MODEL}:generateContent?key=${cleanApiKey}`;
        
        const testPayload = {
            contents: [{ 
                parts: [{ text: "Say 'working' in one word" }] 
            }],
            generationConfig: { 
                maxOutputTokens: 5,
                temperature: 0.1
            }
        };
        
        const response = await fetch(testUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(testPayload)
        });
        
        if (response.ok) {
            const data = await response.json();
            console.log(`   ✅ Model ${WORKING_MODEL} is working!`);
            return true;
        } else {
            const errorText = await response.text();
            let errorMsg = errorText;
            try {
                const errorJson = JSON.parse(errorText);
                errorMsg = errorJson.error?.message || errorText;
            } catch(e) {}
            
            console.log(`   ❌ Model ${WORKING_MODEL} failed: ${response.status} - ${errorMsg}`);
            
            // If model doesn't exist, try to list available models
            if (response.status === 404) {
                console.log('\n📋 Fetching all available models from Google...');
                try {
                    const listResponse = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${cleanApiKey}`);
                    const data = await listResponse.json();
                    
                    if (data.models && Array.isArray(data.models)) {
                        console.log('\n📋 Models that support generateContent:');
                        const workingModels = data.models.filter(model => 
                            model.supportedGenerationMethods && 
                            model.supportedGenerationMethods.includes('generateContent')
                        );
                        
                        workingModels.forEach(m => {
                            console.log(`   ✅ ${m.name}`);
                        });
                        
                        if (workingModels.length > 0) {
                            console.log(`\n💡 Try using: ${workingModels[0].name}`);
                        }
                    }
                } catch (listError) {
                    console.log(`   ❌ Failed to list models: ${listError.message}`);
                }
            }
            
            return false;
        }
    } catch (error) {
        console.log(`   ❌ Error testing model: ${error.message}`);
        return false;
    }
}

// Initialize the model
async function initializeModels() {
    console.log('\n🔧 Initializing AURA AI model...');
    
    API_LLM_URL = `https://generativelanguage.googleapis.com/v1beta/models/${WORKING_MODEL}:generateContent`;
    API_TTS_URL = `https://generativelanguage.googleapis.com/v1beta/models/${WORKING_MODEL}:generateContent`;
    
    const isWorking = await testModel();
    
    if (isWorking) {
        API_READY = true;
        console.log(`\n🚀 AURA AI initialized with: ${WORKING_MODEL}`);
        console.log(`📡 API URL: ${API_LLM_URL}\n`);
        return true;
    } else {
        API_READY = false;
        console.log(`\n❌ Failed to initialize model: ${WORKING_MODEL}`);
        console.log('💡 Troubleshooting tips:');
        console.log('   1. Check if the model name is correct');
        console.log('   2. Verify your API key has access to this model');
        console.log('   3. Check available models at /api/test');
        console.log('   4. Try: gemini-2.0-flash-exp or gemini-1.5-pro\n');
        return false;
    }
}

// Helper function for API calls with retry logic
async function fetchWithRetry(url, payload, maxRetries = 3) {
    const cleanApiKey = GEMINI_API_KEY ? GEMINI_API_KEY.trim().replace(/["']/g, '') : null;
    
    if (!cleanApiKey) {
        throw new Error('GEMINI_API_KEY is not set in environment variables');
    }
    
    if (!url) {
        throw new Error('API URL not initialized. No working model found.');
    }
    
    let retries = 0;
    
    while (retries < maxRetries) {
        try {
            const response = await fetch(`${url}?key=${cleanApiKey}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
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

// Text Generation Endpoint
app.post('/api/chat', async (req, res) => {
    try {
        const { message, imageData, isCommand = false } = req.body;

        if (!message) {
            return res.status(400).json({ 
                success: false, 
                error: 'Message is required' 
            });
        }

        if (!API_READY || !API_LLM_URL) {
            return res.status(503).json({ 
                success: false, 
                error: 'Model not initialized. Please check server logs.' 
            });
        }

        console.log(`📨 User: "${message.substring(0, 50)}${message.length > 50 ? '...' : ''}"`);

        const parts = [{ text: message }];
        
        if (imageData) {
            parts.push({
                inlineData: {
                    mimeType: "image/jpeg",
                    data: imageData
                }
            });
        }

        const chatHistory = [{ role: "user", parts }];

        const llmPayload = {
            contents: chatHistory,
            systemInstruction: { 
                parts: [{ 
                    text: "You are AURA, an advanced AI Humanoid Assistant. Before your response, you MUST prepend an emotion tag. Choose from: [EMOTION: NEUTRAL], [EMOTION: JOY], [EMOTION: INTEREST], or [EMOTION: CONFUSION]. Example: [EMOTION: JOY] That is a fantastic question! Now provide your concise, professional answer." 
                }] 
            },
            generationConfig: {
                temperature: 0.7,
                maxOutputTokens: 2048,
                topK: 40,
                topP: 0.95
            }
        };

        console.log('🔄 Calling Gemini API...');
        const responseData = await fetchWithRetry(API_LLM_URL, llmPayload);
        const candidate = responseData.candidates?.[0];

        if (!candidate) {
            throw new Error("Invalid response structure from LLM");
        }

        const generatedText = candidate.content?.parts?.[0]?.text;
        
        if (!generatedText) {
            throw new Error("No text generated from LLM");
        }

        const emotionMatch = generatedText.match(/\[EMOTION: (NEUTRAL|JOY|INTEREST|CONFUSION)\]/i);
        const emotion = emotionMatch ? emotionMatch[1].toUpperCase() : 'NEUTRAL';
        const cleanText = generatedText.replace(/\[EMOTION: (NEUTRAL|JOY|INTEREST|CONFUSION)\]/i, '').trim();

        console.log(`✅ Response: ${cleanText.substring(0, 50)}...`);

        res.json({
            success: true,
            text: cleanText,
            emotion: emotion,
            hasImage: !!imageData,
            sources: [],
            model: WORKING_MODEL
        });

    } catch (error) {
        console.error('❌ Chat API Error:', error);
        res.status(500).json({ 
            success: false, 
            error: error.message || 'Internal server error' 
        });
    }
});

// TTS Endpoint
app.post('/api/tts', async (req, res) => {
    try {
        const { text } = req.body;
        
        if (!text) {
            return res.status(400).json({ 
                success: false, 
                error: 'Text is required for TTS' 
            });
        }

        res.json({
            success: true,
            audioData: null,
            mimeType: 'audio/wav'
        });
        
    } catch (error) {
        console.error('TTS API Error:', error);
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

// Health check endpoint
app.get('/api/health', (req, res) => {
    res.json({ 
        status: 'OK', 
        timestamp: new Date().toISOString(),
        hasApiKey: !!GEMINI_API_KEY,
        workingModel: WORKING_MODEL,
        apiUrl: API_LLM_URL || 'Not set',
        isReady: API_READY
    });
});

// Test endpoint for debugging
app.get('/api/test', async (req, res) => {
    try {
        const cleanApiKey = GEMINI_API_KEY ? GEMINI_API_KEY.trim().replace(/["']/g, '') : null;
        
        if (!cleanApiKey) {
            return res.status(400).json({ 
                error: 'API key not set',
                message: 'Please set GEMINI_API_KEY in .env file'
            });
        }
        
        // Test listing models
        const listResponse = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${cleanApiKey}`);
        const listData = await listResponse.json();
        
        // Filter models that support generateContent
        let availableModels = [];
        if (listData.models && Array.isArray(listData.models)) {
            availableModels = listData.models
                .filter(m => m.supportedGenerationMethods?.includes('generateContent'))
                .map(m => m.name);
        }
        
        // Test the specific model
        const testUrl = `https://generativelanguage.googleapis.com/v1beta/models/${WORKING_MODEL}:generateContent?key=${cleanApiKey}`;
        const testPayload = {
            contents: [{ parts: [{ text: "Say 'working' in one word" }] }],
            generationConfig: { maxOutputTokens: 10 }
        };
        
        const testResponse = await fetch(testUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(testPayload)
        });
        
        let testData = null;
        let testOk = testResponse.ok;
        
        try {
            testData = await testResponse.json();
        } catch(e) {
            testData = { error: 'Could not parse response' };
        }
        
        res.json({
            status: 'Test Results',
            apiKeyValid: !!cleanApiKey,
            workingModel: WORKING_MODEL,
            modelTestStatus: testResponse.status,
            modelTestOk: testOk,
            modelTestData: testData,
            availableModels: availableModels,
            isModelInList: availableModels.includes(WORKING_MODEL),
            apiReady: API_READY,
            apiUrl: API_LLM_URL
        });
    } catch (error) {
        res.status(500).json({ 
            error: error.message,
            stack: error.stack
        });
    }
});

// Serve frontend
app.get('/', (req, res) => {
    res.sendFile(__dirname + '/public/index.html');
});

// Start server
app.listen(PORT, async () => {
    console.log(`\n🚀 AURA Backend Server running on port ${PORT}`);
    console.log(`🔐 API Key Status: ${GEMINI_API_KEY ? '✅ Loaded' : '❌ Missing'}`);
    
    if (GEMINI_API_KEY) {
        console.log(`📝 API Key (first 8 chars): ${GEMINI_API_KEY.substring(0, 8)}...`);
        console.log(`🎯 Using model: ${WORKING_MODEL}`);
        await initializeModels();
    } else {
        console.log('\n⚠️  WARNING: GEMINI_API_KEY not found in .env file');
        console.log('   Please create a .env file with:');
        console.log('   GEMINI_API_KEY=your_api_key_here');
        console.log('   PORT=3000\n');
    }
    
    console.log(`\n🌐 Server URL: http://localhost:${PORT}`);
    console.log(`📡 API Endpoints:`);
    console.log(`   - POST /api/chat   - Send messages to AURA`);
    console.log(`   - POST /api/tts    - Text-to-speech`);
    console.log(`   - GET  /api/health - Check status`);
    console.log(`   - GET  /api/test   - Debug API connection`);
    
    if (API_READY) {
        console.log(`\n✅ AURA is ONLINE and ready to respond!`);
    } else {
        console.log(`\n⚠️ AURA is starting but model not ready yet.`);
        console.log(`   Visit /api/test to debug the issue.\n`);
    }
    console.log();
});

process.on('SIGTERM', () => {
    console.log('SIGTERM received, shutting down gracefully');
    process.exit(0);
});
