import { createRoot } from 'react-dom/client';
import { Options } from './Options';
import './options.css';

const container = document.getElementById('root');
if (container) {
  createRoot(container).render(<Options />);
}
