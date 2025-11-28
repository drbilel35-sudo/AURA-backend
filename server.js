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
const API_LLM_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-09-2025:generateContent';
const API_TTS_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-tts:generateContent';

// Helper function for API calls with retry logic
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
            } else if (response.status === 429 || response.status >= 500) {
                retries++;
                const delay = 1000 * Math.pow(2, retries);
                await new Promise(resolve => setTimeout(resolve, delay));
            } else {
                throw new Error(`API returned status ${response.status}`);
            }
        } catch (error) {
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
            tools: isCommand ? [] : [{ "google_search": {} }],
            systemInstruction: { 
                parts: [{ 
                    text: "You are AURA, an advanced AI Humanoid Assistant. Before your response, you MUST prepend an emotion tag. Choose the most appropriate tag from: [EMOTION: NEUTRAL], [EMOTION: JOY], [EMOTION: INTEREST], or [EMOTION: CONFUSION]. Example: [EMOTION: JOY] That is a fantastic question! Now, provide your concise, professional, and helpful answer. If the user provides an image, analyze it and describe what you see before answering the question." 
                }] 
            },
        };

        const responseData = await fetchWithRetry(API_LLM_URL, llmPayload);
        const candidate = responseData.candidates?.[0];

        if (!candidate) {
            throw new Error("Invalid response structure from LLM");
        }

        const generatedText = candidate.content?.parts?.[0]?.text;
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
            },
            model: "gemini-2.5-flash-preview-tts"
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
        hasApiKey: !!GEMINI_API_KEY
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
    console.log(`🌐 Server URL: http://localhost:${PORT}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('SIGTERM received, shutting down gracefully');
    process.exit(0);
});
