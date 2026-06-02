import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import dotenv from 'dotenv';
import { errorHandler } from './middlewares/errorHandler';
import routes from './routes';
import { initializeQdrant } from './qdrant/client';
import { initEmbeddingModel } from './services/embedding.service';
import { initTranscriber } from './services/transcription.service';

dotenv.config();

const app = express();

// Allow Next.js dev server (3000) and same-origin requests
app.use(cors({
  origin: ['http://localhost:3000', 'http://127.0.0.1:3000'],
  credentials: true,
}));
app.use(helmet({ crossOriginResourcePolicy: false }));
app.use(morgan('dev'));
app.use(express.json({ limit: '10mb' }));

// Main routes
app.use('/api', routes);

// Error handling middleware
app.use(errorHandler);

const PORT = process.env.PORT || 3001;

app.listen(PORT, async () => {
  console.log(`Server starting on port ${PORT}`);
  
  // Warm up the models in the background asynchronously so we don't block server startup
  initEmbeddingModel().catch(err => console.error("❌ Failed to warm up BGE embedding model:", err));
  initTranscriber().catch(err => console.error("❌ Failed to warm up Whisper transcriber model:", err));

  await initializeQdrant();
  console.log(`✅ Server ready on http://localhost:${PORT}`);
});
