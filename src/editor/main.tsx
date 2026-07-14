import { createRoot } from 'react-dom/client';
import { Editor } from './Editor';
import './editor.css';

const container = document.getElementById('root');
if (container) {
  createRoot(container).render(<Editor />);
}
