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

// Global variable for working model
let WORKING_MODEL = null;
let API_LLM_URL = null;
let API_TTS_URL = null;

// Function to find a working model - FIXED VERSION
async function findWorkingModel() {
    if (!GEMINI_API_KEY) return null;
    
    try {
        const cleanApiKey = GEMINI_API_KEY.trim().replace(/["']/g, '');
        
        // Updated list of correct Gemini model names
        const modelsToTry = [
            'gemini-2.0-flash-exp',
            'gemini-2.0-flash',
            'gemini-1.5-pro',
            'gemini-1.5-flash',
            'gemini-1.0-pro',
            'gemini-pro'
        ];
        
        console.log('\n🔍 Testing Gemini models...');
        
        for (const model of modelsToTry) {
            console.log(`   Testing: ${model}`);
            const testUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${cleanApiKey}`;
            
            try {
                const testPayload = {
                    contents: [{ 
                        parts: [{ text: "test" }] 
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
                    console.log(`   ✅ Model ${model} is working!`);
                    return model;
                } else {
                    const errorText = await response.text();
                    let errorMsg = errorText;
                    try {
                        const errorJson = JSON.parse(errorText);
                        errorMsg = errorJson.error?.message || errorText;
                    } catch(e) {}
                    
                    console.log(`   ❌ ${model} failed: ${response.status} - ${errorMsg.substring(0, 100)}`);
                    
                    // If it's an auth error, stop trying
                    if (response.status === 401 || response.status === 403) {
                        console.log('   ⚠️ Authentication error - check your API key');
                        break;
                    }
                }
            } catch (error) {
                console.log(`   ❌ ${model} error: ${error.message}`);
            }
            
            // Small delay between requests to avoid rate limiting
            await new Promise(resolve => setTimeout(resolve, 500));
        }
        
        // If no model works, try listing all available models
        console.log('\n📋 Fetching all available models from Google...');
        try {
            const listResponse = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${cleanApiKey}`);
            const data = await listResponse.json();
            
            if (data.models && Array.isArray(data.models)) {
                console.log('\n📋 Available models that support generateContent:');
                
                // Filter models that support generateContent
                const workingModels = data.models.filter(model => 
                    model.supportedGenerationMethods && 
                    model.supportedGenerationMethods.includes('generateContent')
                );
                
                if (workingModels.length > 0) {
                    // Log all working models
                    workingModels.forEach(m => {
                        console.log(`   ✅ ${m.name}`);
                    });
                    
                    // Select the first working model
                    const selectedModel = workingModels[0].name;
                    console.log(`\n🎯 Selected: ${selectedModel}`);
                    return selectedModel;
                } else {
                    console.log('   ❌ No models found that support generateContent');
                    console.log('   All models:', data.models.map(m => m.name).join(', '));
                }
            } else {
                console.log('   ❌ Unexpected response from models endpoint');
            }
        } catch (error) {
            console.log(`   ❌ Failed to list models: ${error.message}`);
        }
        
        return null;
    } catch (error) {
        console.error('❌ Failed to find model:', error.message);
        return null;
    }
}

// Initialize models on startup
async function initializeModels() {
    console.log('\n🔧 Initializing AURA AI model...');
    
    const modelName = await findWorkingModel();
    
    if (modelName) {
        WORKING_MODEL = modelName;
        API_LLM_URL = `https://generativelanguage.googleapis.com/v1beta/models/${WORKING_MODEL}:generateContent`;
        API_TTS_URL = `https://generativelanguage.googleapis.com/v1beta/models/${WORKING_MODEL}:generateContent`;
        console.log(`\n🚀 Using model: ${WORKING_MODEL}`);
        console.log(`📡 API URL: ${API_LLM_URL}\n`);
        return true;
    } else {
        console.error('\n❌ Failed to find a working model.');
        console.log('💡 Troubleshooting tips:');
        console.log('   1. Check your GEMINI_API_KEY in .env file');
        console.log('   2. Verify the API key is active in Google Cloud Console');
        console.log('   3. Make sure the Gemini API is enabled for your project');
        console.log('   4. Check your internet connection');
        console.log('   5. Try creating a new API key\n');
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

        if (!API_LLM_URL) {
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
        workingModel: WORKING_MODEL || 'Not initialized',
        apiUrl: API_LLM_URL || 'Not set',
        isReady: !!API_LLM_URL
    });
});

// Test endpoint for debugging
app.get('/api/test', async (req, res) => {
    try {
        const cleanApiKey = GEMINI_API_KEY ? GEMINI_API_KEY.trim().replace(/["']/g, '') : null;
        
        if (!cleanApiKey) {
            return res.status(400).json({ error: 'API key not set' });
        }
        
        // Test listing models
        const listResponse = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${cleanApiKey}`);
        const listData = await listResponse.json();
        
        // Test a specific model
        const testModel = WORKING_MODEL || 'gemini-1.5-pro';
        const testUrl = `https://generativelanguage.googleapis.com/v1beta/models/${testModel}:generateContent?key=${cleanApiKey}`;
        const testPayload = {
            contents: [{ parts: [{ text: "Say 'working' in one word" }] }],
            generationConfig: { maxOutputTokens: 10 }
        };
        
        const testResponse = await fetch(testUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(testPayload)
        });
        
        const testData = await testResponse.json();
        
        res.json({
            status: 'Test Results',
            apiKeyValid: !!cleanApiKey,
            listModels: listData.models ? listData.models.length : 0,
            testModel: testModel,
            testStatus: testResponse.status,
            testOk: testResponse.ok,
            testData: testData,
            workingModel: WORKING_MODEL,
            apiUrl: API_LLM_URL
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
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
        const initialized = await initializeModels();
        if (!initialized) {
            console.log('\n⚠️ Model initialization failed. The server will still run but /api/chat will return errors.');
            console.log('   Visit /api/test to debug the issue.\n');
        }
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
    console.log(`   - GET  /api/test   - Debug API connection\n`);
});

process.on('SIGTERM', () => {
    console.log('SIGTERM received, shutting down gracefully');
    process.exit(0);
});
