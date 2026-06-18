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

// Function to find a working model
async function findWorkingModel() {
    if (!GEMINI_API_KEY) return null;
    
    try {
        const cleanApiKey = GEMINI_API_KEY.trim().replace(/["']/g, '');
        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${cleanApiKey}`);
        const data = await response.json();
        
        console.log('\n📋 Available models from Google:');
        
        if (data.models && Array.isArray(data.models)) {
            // Find models that support generateContent
            const workingModels = data.models.filter(model => 
                model.supportedGenerationMethods && 
                model.supportedGenerationMethods.includes('generateContent')
            );
            
            if (workingModels.length === 0) {
                console.error('❌ No models found that support generateContent');
                return null;
            }
            
            console.log(`\n✅ Found ${workingModels.length} model(s) that support generateContent:`);
            workingModels.forEach(model => {
                console.log(`   - ${model.name}`);
            });
            
            // Use the first working model
            const selectedModel = workingModels[0].name;
            console.log(`\n🎯 Selected model: ${selectedModel}`);
            
            return selectedModel;
        } else {
            console.error('❌ Unexpected API response structure:', JSON.stringify(data, null, 2));
            return null;
        }
    } catch (error) {
        console.error('❌ Failed to fetch models:', error.message);
        return null;
    }
}

// Initialize models on startup
async function initializeModels() {
    const modelName = await findWorkingModel();
    
    if (modelName) {
        WORKING_MODEL = modelName;
        API_LLM_URL = `https://generativelanguage.googleapis.com/v1beta/models/${WORKING_MODEL}:generateContent`;
        API_TTS_URL = `https://generativelanguage.googleapis.com/v1beta/models/${WORKING_MODEL}:generateContent`;
        console.log(`\n🚀 Using model: ${WORKING_MODEL}`);
        console.log(`📡 API URL: ${API_LLM_URL}\n`);
        return true;
    } else {
        console.error('\n❌ Failed to find a working model. Using fallback model list...');
        // Fallback to try common model names
        const fallbackModels = [
            'gemini-2.5-pro',
            'gemini-pro', 
            'gemini-1.0-pro-latest',
            'gemini-1.0-pro-001'
        ];
        
        for (const model of fallbackModels) {
            console.log(`   Trying fallback: ${model}`);
            WORKING_MODEL = model;
            API_LLM_URL = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
            API_TTS_URL = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
            
            // Test if it works
            try {
                const testPayload = {
                    contents: [{ parts: [{ text: "test" }] }],
                    generationConfig: { maxOutputTokens: 10 }
                };
                const cleanApiKey = GEMINI_API_KEY.trim().replace(/["']/g, '');
                const testResponse = await fetch(`${API_LLM_URL}?key=${cleanApiKey}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(testPayload)
                });
                
                if (testResponse.ok) {
                    console.log(`   ✅ Model ${model} works!`);
                    return true;
                }
            } catch (e) {
                // Continue to next model
            }
        }
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
                    console.log(`Retry ${retries}/${maxRetries} in ${delay}ms...`);
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
            return res.status(400).json({ error: 'Message is required' });
        }

        if (!API_LLM_URL) {
            return res.status(503).json({ 
                success: false, 
                error: 'Model not initialized. Please check server logs.' 
            });
        }

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
            }
        };

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

        res.json({
            success: true,
            text: cleanText,
            emotion: emotion,
            hasImage: !!imageData
        });

    } catch (error) {
        console.error('Chat API Error:', error);
        res.status(500).json({ 
            success: false, 
            error: error.message || 'Internal server error' 
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
        apiUrl: API_LLM_URL || 'Not set'
    });
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
        await initializeModels();
    }
    
    console.log(`\n🌐 Server URL: http://localhost:${PORT}`);
    console.log(`📡 API Endpoints:`);
    console.log(`   - POST /api/chat`);
    console.log(`   - GET  /api/health\n`);
});

process.on('SIGTERM', () => {
    console.log('SIGTERM received, shutting down gracefully');
    process.exit(0);
});
