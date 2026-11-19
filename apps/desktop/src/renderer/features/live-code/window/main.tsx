import { createRoot } from 'react-dom/client';
import { Inspector } from './Inspector';
import './inspector.css';

const container = document.getElementById('root');
if (!container) throw new Error('missing #root');
createRoot(container).render(<Inspector bridge={window.allayCodeInspector} />);
