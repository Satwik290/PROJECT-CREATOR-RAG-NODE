import { Router } from 'express';
import { ingestVideo } from '../controllers/ingest.controller';
import { chatStream } from '../controllers/chat.controller';
import { validateRequest } from '../middlewares/validateRequest';
import { ingestSchema, chatSchema } from '../validators/schemas';

const router = Router();

router.post('/ingest', validateRequest(ingestSchema), ingestVideo);
router.post('/chat', validateRequest(chatSchema), chatStream);

export default router;
