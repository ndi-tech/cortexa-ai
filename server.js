require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');
const cors = require('cors');
const multer = require('multer');
const OpenAI = require('openai');
const { PdfReader } = require("pdfreader");
const Tesseract = require('tesseract.js');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const openai = new OpenAI({ 
    apiKey: process.env.OPENAI_API_KEY,
    baseURL: "https://openrouter.ai/api/v1" 
});

const upload = multer({ storage: multer.memoryStorage() }).fields([
    { name: 'file', maxCount: 1 },
    { name: 'pdf', maxCount: 1 }
]);

mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('✅ Connected to MongoDB Atlas'))
  .catch((err) => console.log('❌ MongoDB Connection Error:', err.message));

// --- MODELS ---
const UserSchema = new mongoose.Schema({
    email: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    createdAt: { type: Date, default: Date.now }
});
const User = mongoose.model('User', UserSchema);

const UploadSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    fileName: { type: String, required: true },
    textContent: { type: String, default: "" }, 
    createdAt: { type: Date, default: Date.now }
});
const Upload = mongoose.model('Upload', UploadSchema);

const ChatSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    fileId: { type: mongoose.Schema.Types.ObjectId, ref: 'Upload', required: true },
    role: { type: String, enum: ['user', 'assistant'], required: true },
    content: { type: String, required: true },
    createdAt: { type: Date, default: Date.now }
});
const Chat = mongoose.model('Chat', ChatSchema);

// --- AUTH ROUTES ---
app.post('/api/auth/signup', async (req, res) => {
    try {
        const { email, password } = req.body;
        const existingUser = await User.findOne({ email });
        if (existingUser) return res.status(400).json({ error: 'User already exists' });
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);
        const newUser = new User({ email, password: hashedPassword });
        await newUser.save();
        const token = jwt.sign({ userId: newUser._id }, process.env.JWT_SECRET, { expiresIn: '30d' });
        res.status(201).json({ message: 'User created successfully', token });
    } catch (error) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/auth/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        const user = await User.findOne({ email });
        if (!user) return res.status(400).json({ error: 'Invalid credentials' });
        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) return res.status(400).json({ error: 'Invalid credentials' });
        const token = jwt.sign({ userId: user._id }, process.env.JWT_SECRET, { expiresIn: '30d' });
        res.json({ message: 'Logged in successfully', token });
    } catch (error) { res.status(500).json({ error: 'Server error' }); }
});

// --- VERIFY TOKEN ---
const verifyToken = (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'Access denied' });
    try {
        const verified = jwt.verify(authHeader.split(' ')[1], process.env.JWT_SECRET);
        req.userId = verified.userId;
        next();
    } catch (error) { res.status(400).json({ error: 'Invalid token' }); }
};

// --- FETCH HISTORY ---
app.get('/api/history/chats/:fileId', verifyToken, async (req, res) => {
    try {
        const chats = await Chat.find({ userId: req.userId, fileId: req.params.fileId }).sort({ createdAt: 1 });
        res.json(chats);
    } catch (error) { res.status(500).json({ error: 'Failed to fetch chats' }); }
});

app.get('/api/history/files', verifyToken, async (req, res) => {
    try {
        const files = await Upload.find({ userId: req.userId }).sort({ createdAt: -1 });
        res.json(files);
    } catch (error) { res.status(500).json({ error: 'Failed to fetch files' }); }
});

// --- UPLOAD ROUTE (Extracts and saves text instantly) ---
app.post('/api/upload', upload, async (req, res) => {
    try {
        const token = req.headers.authorization ? req.headers.authorization.split(' ')[1] : null;
        if (!token) return res.status(401).json({ error: 'Unauthorized' });
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        
        let uploadedFile = null;
        if (req.files) {
            if (req.files.file && req.files.file.length > 0) uploadedFile = req.files.file[0];
            else if (req.files.pdf && req.files.pdf.length > 0) uploadedFile = req.files.pdf[0];
        }

        if (!uploadedFile) return res.status(400).json({ error: 'No file uploaded' });

        let documentText = "";
        const mimeType = uploadedFile.mimetype;

        if (mimeType === 'application/pdf') {
            await new Promise((resolve, reject) => {
                new PdfReader().parseBuffer(uploadedFile.buffer, (err, item) => {
                    if (err) reject(err);
                    else if (!item) resolve();
                    else if (item.text) documentText += item.text + " ";
                });
            });
        } else if (mimeType === 'text/plain') {
            documentText = uploadedFile.buffer.toString('utf-8');
        } else if (mimeType.startsWith('image/')) {
            const { data: { text } } = await Tesseract.recognize(uploadedFile.buffer, 'eng');
            documentText = text;
        }
        documentText = documentText.substring(0, 150000); 

        const newFile = await Upload.create({ 
            userId: decoded.userId, 
            fileName: uploadedFile.originalname,
            textContent: documentText 
        });
        
        res.status(200).json({ message: 'File saved', file: newFile });
    } catch (error) { 
        console.error("Upload Error:", error);
        res.status(500).json({ error: 'Failed to save file' }); 
    }
});

// --- AI CHAT ROUTE ---
app.post('/api/chat', upload, async (req, res) => {
    try {
        const userQuestion = req.body.question;
        const selectedModel = req.body.model || "openai/gpt-4o-mini"; 
        const fileId = req.body.fileId; 
        
        const token = req.headers.authorization ? req.headers.authorization.split(' ')[1] : null;
        let userId = null;
        if(token) {
            const decoded = jwt.verify(token, process.env.JWT_SECRET);
            userId = decoded.userId;
        }

        let uploadedFile = null;
        if (req.files) {
            if (req.files.file && req.files.file.length > 0) uploadedFile = req.files.file[0];
            else if (req.files.pdf && req.files.pdf.length > 0) uploadedFile = req.files.pdf[0];
        }

        let documentText = "";

        if (uploadedFile) {
            const mimeType = uploadedFile.mimetype;
            if (mimeType === 'application/pdf') {
                await new Promise((resolve, reject) => {
                    new PdfReader().parseBuffer(uploadedFile.buffer, (err, item) => {
                        if (err) reject(err);
                        else if (!item) resolve();
                        else if (item.text) documentText += item.text + " ";
                    });
                });
            } else if (mimeType === 'text/plain') {
                documentText = uploadedFile.buffer.toString('utf-8');
            } else if (mimeType.startsWith('image/')) {
                const { data: { text } } = await Tesseract.recognize(uploadedFile.buffer, 'eng');
                documentText = text;
            }
            documentText = documentText.substring(0, 150000); 
        } 
        else if (fileId) {
            const existingFile = await Upload.findById(fileId);
            if (existingFile && existingFile.textContent) {
                documentText = existingFile.textContent;
            }
        }

        if (!userQuestion) return res.status(400).json({ error: "Please provide a question." });

        if (userId && fileId) {
            await Chat.create({ userId, fileId, role: 'user', content: userQuestion });
        }

        const systemPrompt = `You are Cortexa, an expert AI Study Assistant. 
        Document text: \n${documentText}\n
        Formatting Rules:
        1. ALWAYS use Markdown for your responses. Use **bold** for key terms, bullet points for lists, and headers (###) to organize sections.
        2. If the user asks for a summary or key points, structure it beautifully with clear headings and bolded main ideas.
        3. If the user asks a specific question, answer it clearly based on the text.
        4. If the document doesn't have the answer, use your general knowledge but politely note it's outside the document.
        5. Keep responses concise but comprehensive.`;

        const response = await openai.chat.completions.create({
            model: selectedModel, 
            messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userQuestion }],
            temperature: 0.4, 
        });

        const aiAnswer = response.choices[0].message.content;

        if (userId && fileId) {
            await Chat.create({ userId, fileId, role: 'assistant', content: aiAnswer });
        }

        res.json({ answer: aiAnswer });
    } catch (error) {
        console.error("AI Error:", error);
        res.status(500).json({ error: "Failed to process file or AI response." });
    }
});

app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Cortexa AI Server running on port ${PORT}`));