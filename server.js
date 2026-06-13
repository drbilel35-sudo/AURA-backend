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
// CORRECTED: Using valid Gemini model names
const API_LLM_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent';
const API_TTS_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent';

// Helper function for API calls with retry logic and detailed error reporting
async function fetchWithRetry(url, payload, maxRetries = 3) {
    let retries = 0;
    
    while (retries < maxRetries) {
        try {
            const response = await fetch(`${url}?key=${GEMINI_API_KEY}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            if (response.ok) {
                return await response.json();
            } else {
                // Get detailed error message from API
                const errorText = await response.text();
                let errorDetail = errorText;
                try {
                    const errorJson = JSON.parse(errorText);
                    errorDetail = errorJson.error?.message || errorText;
                } catch(e) {
                    // Keep raw text if not JSON
                }
                
                if (response.status === 429) {
                    retries++;
                    const delay = 1000 * Math.pow(2, retries);
                    console.log(`Rate limited, retrying in ${delay}ms...`);
                    await new Promise(resolve => setTimeout(resolve, delay));
                } else if (response.status >= 500) {
                    retries++;
                    const delay = 1000 * Math.pow(2, retries);
                    console.log(`Server error, retrying in ${delay}ms...`);
                    await new Promise(resolve => setTimeout(resolve, delay));
                } else {
                    throw new Error(`API returned status ${response.status}: ${errorDetail}`);
                }
            }
        } catch (error) {
            if (error.message.includes('API returned status')) {
                throw error;
            }
            retries++;
            if (retries >= maxRetries) throw error;
            const delay = 1000 * Math.pow(2, retries);
            console.log(`Request failed, retrying in ${delay}ms...`);
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

        // Construct payload for Gemini
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
            // Commented out google_search tool as it may not be available in all versions
            // tools: isCommand ? [] : [{ "google_search": {} }],
            systemInstruction: { 
                parts: [{ 
                    text: "You are AURA, an advanced AI Humanoid Assistant. Before your response, you MUST prepend an emotion tag. Choose the most appropriate tag from: [EMOTION: NEUTRAL], [EMOTION: JOY], [EMOTION: INTEREST], or [EMOTION: CONFUSION]. Example: [EMOTION: JOY] That is a fantastic question! Now, provide your concise, professional, and helpful answer. If the user provides an image, analyze it and describe what you see before answering the question." 
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
            console.error('Invalid response structure:', JSON.stringify(responseData, null, 2));
            throw new Error("Invalid response structure from LLM");
        }

        const generatedText = candidate.content?.parts?.[0]?.text;
        
        if (!generatedText) {
            throw new Error("No text generated from LLM");
        }

        const emotionMatch = generatedText.match(/\[EMOTION: (NEUTRAL|JOY|INTEREST|CONFUSION)\]/i);
        
        const emotion = emotionMatch ? emotionMatch[1].toUpperCase() : 'NEUTRAL';
        const cleanText = generatedText.replace(/\[EMOTION: (NEUTRAL|JOY|INTEREST|CONFUSION)\]/i, '').trim();

        // Extract sources if available
        const sources = [];
        const groundingMetadata = candidate.groundingMetadata;
        if (groundingMetadata && groundingMetadata.groundingAttributions) {
            groundingMetadata.groundingAttributions.forEach(attribution => {
                if (attribution.web?.uri && attribution.web?.title) {
                    sources.push({
                        uri: attribution.web.uri,
                        title: attribution.web.title
                    });
                }
            });
        }

        res.json({
            success: true,
            text: cleanText,
            emotion: emotion,
            sources: sources,
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

// Text-to-Speech Endpoint
app.post('/api/tts', async (req, res) => {
    try {
        const { text } = req.body;

        if (!text) {
            return res.status(400).json({ error: 'Text is required for TTS' });
        }

        const ttsPayload = {
            contents: [{ parts: [{ text }] }],
            generationConfig: {
                responseModalities: ["AUDIO"],
                speechConfig: {
                    voiceConfig: { prebuiltVoiceConfig: { voiceName: "Kore" } }
                }
            }
        };

        const responseData = await fetchWithRetry(API_TTS_URL, ttsPayload);
        const part = responseData?.candidates?.[0]?.content?.parts?.[0];
        const audioData = part?.inlineData?.data;
        const mimeType = part?.inlineData?.mimeType;

        if (!audioData || !mimeType) {
            throw new Error("TTS failed to generate audio data");
        }

        res.json({
            success: true,
            audioData: audioData,
            mimeType: mimeType
        });

    } catch (error) {
        console.error('TTS API Error:', error);
        res.status(500).json({ 
            success: false, 
            error: error.message || 'TTS generation failed' 
        });
    }
});

// Health check endpoint
app.get('/api/health', (req, res) => {
    res.json({ 
        status: 'OK', 
        timestamp: new Date().toISOString(),
        hasApiKey: !!GEMINI_API_KEY,
        apiKeyPrefix: GEMINI_API_KEY ? GEMINI_API_KEY.substring(0, 8) + '...' : 'Missing'
    });
});

// Serve frontend
app.get('/', (req, res) => {
    res.sendFile(__dirname + '/public/index.html');
});

// Start server
app.listen(PORT, () => {
    console.log(`🚀 AURA Backend Server running on port ${PORT}`);
    console.log(`🔐 API Key Status: ${GEMINI_API_KEY ? '✅ Loaded' : '❌ Missing'}`);
    if (GEMINI_API_KEY) {
        console.log(`📝 API Key (first 8 chars): ${GEMINI_API_KEY.substring(0, 8)}...`);
    }
    console.log(`🌐 Server URL: http://localhost:${PORT}`);
    console.log(`📡 API Endpoints:`);
    console.log(`   - POST /api/chat`);
    console.log(`   - POST /api/tts`);
    console.log(`   - GET  /api/health`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('SIGTERM received, shutting down gracefully');
    process.exit(0);
});
