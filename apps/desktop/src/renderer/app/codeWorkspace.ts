import { lazy, type ComponentType } from 'react';

const codeModules = import.meta.glob<{ CodeStudio: ComponentType }>('../features/authoring/CodeStudio.tsx');
const loadCode = codeModules['../features/authoring/CodeStudio.tsx'];

export const CodeStudio = loadCode ? lazy(async () => ({ default: (await loadCode()).CodeStudio })) : null;
