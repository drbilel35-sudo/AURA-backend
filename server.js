const express = require('express');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static('public'));

// API Key
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// Fixed model (recommended)
const WORKING_MODEL = 'gemini-2.5-flash';

const API_LLM_URL =
  `https://generativelanguage.googleapis.com/v1beta/models/${WORKING_MODEL}:generateContent`;

console.log('===================================');
console.log('🚀 AURA Backend Starting...');
console.log('API Key Loaded:', !!GEMINI_API_KEY);
console.log('Model:', WORKING_MODEL);
console.log('===================================');

// Helper function
async function fetchWithRetry(url, payload, maxRetries = 3) {

    if (!GEMINI_API_KEY) {
        throw new Error('GEMINI_API_KEY is missing');
    }

    let retries = 0;

    while (retries < maxRetries) {

        try {

            const response = await fetch(
                `${url}?key=${GEMINI_API_KEY.trim()}`,
                {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(payload)
                }
            );

            if (response.ok) {
                return await response.json();
            }

            const errorText = await response.text();

            if (response.status === 429 || response.status >= 500) {

                retries++;

                const delay = 1000 * Math.pow(2, retries);

                console.log(`Retry ${retries}/${maxRetries}`);

                await new Promise(resolve => setTimeout(resolve, delay));

            } else {

                throw new Error(
                    `API returned status ${response.status}: ${errorText}`
                );

            }

        } catch (error) {

            retries++;

            if (retries >= maxRetries) throw error;

            await new Promise(resolve =>
                setTimeout(resolve, 1000 * retries)
            );

        }

    }

    throw new Error('All retries failed');
}

// Root endpoint
app.get('/', (req, res) => {

    res.send('✅ AURA Backend Running');

});

// Test endpoint
app.get('/test', (req, res) => {

    res.json({
        success: true,
        message: 'AURA backend is working'
    });

});

// Health endpoint
app.get('/api/health', (req, res) => {

    res.json({
        status: 'OK',
        timestamp: new Date().toISOString(),
        hasApiKey: !!GEMINI_API_KEY,
        workingModel: WORKING_MODEL,
        apiUrl: API_LLM_URL
    });

});

// Chat endpoint
app.post('/api/chat', async (req, res) => {

    try {

        const { message, imageData } = req.body;

        if (!message) {

            return res.status(400).json({
                success: false,
                error: 'Message is required'
            });

        }

        const parts = [
            {
                text: message
            }
        ];

        if (imageData) {

            parts.push({
                inlineData: {
                    mimeType: 'image/jpeg',
                    data: imageData
                }
            });

        }

        const payload = {

            contents: [
                {
                    role: 'user',
                    parts
                }
            ],

            systemInstruction: {

                parts: [
                    {
                        text:
                            "You are AURA, an advanced AI assistant. Before every answer add one of these tags: [EMOTION: NEUTRAL], [EMOTION: JOY], [EMOTION: INTEREST], [EMOTION: CONFUSION]."
                    }
                ]

            },

            generationConfig: {

                temperature: 0.7,
                maxOutputTokens: 2048

            }

        };

        const responseData =
            await fetchWithRetry(API_LLM_URL, payload);

        const candidate =
            responseData.candidates?.[0];

        if (!candidate) {

            throw new Error(
                'No response generated'
            );

        }

        const generatedText =
            candidate.content.parts[0].text;

        const emotionMatch =
            generatedText.match(
                /\[EMOTION: (NEUTRAL|JOY|INTEREST|CONFUSION)\]/i
            );

        const emotion =
            emotionMatch
                ? emotionMatch[1].toUpperCase()
                : 'NEUTRAL';

        const cleanText =
            generatedText.replace(
                /\[EMOTION: (NEUTRAL|JOY|INTEREST|CONFUSION)\]/i,
                ''
            ).trim();

        res.json({

            success: true,
            text: cleanText,
            emotion,
            hasImage: !!imageData

        });

    } catch (error) {

        console.error(error);

        res.status(500).json({

            success: false,
            error: error.message

        });

    }

});

// TTS endpoint
app.post('/api/tts', (req, res) => {

    res.json({

        success: true,
        audioData: null,
        mimeType: 'audio/wav'

    });

});

// Start server
app.listen(PORT, () => {

    console.log(`🚀 AURA Server running on port ${PORT}`);

    console.log(`📡 Chat endpoint: /api/chat`);
    console.log(`📡 Health endpoint: /api/health`);
    console.log(`📡 Test endpoint: /test`);

});

// Graceful shutdown
process.on('SIGTERM', () => {

    console.log('SIGTERM received');

    process.exit(0);

});
