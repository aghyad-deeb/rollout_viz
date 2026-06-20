import { useCallback } from 'react';
import { buildPublicUrl } from '../config';

interface UrlState {
  file?: string;
  rollout?: number;  // Use rollout_n as unique identifier
  step?: number;     // Disambiguate samples with same rollout_n at different steps
  index?: number;    // Sample's position within the file (for exact disambiguation)
  message?: number;
  highlight?: string;
}

export function useUrlState() {
  // Parse URL parameters on mount
  const getUrlState = useCallback((): UrlState => {
    const params = new URLSearchParams(window.location.search);
    const state: UrlState = {};
    
    const file = params.get('file');
    if (file) state.file = file;
    
    const rollout = params.get('rollout');
    if (rollout) state.rollout = parseInt(rollout, 10);

    const step = params.get('step');
    if (step) state.step = parseInt(step, 10);

    const index = params.get('index');
    if (index) state.index = parseInt(index, 10);

    const message = params.get('message');
    if (message) state.message = parseInt(message, 10);
    
    const highlight = params.get('highlight');
    if (highlight) state.highlight = highlight;
    
    return state;
  }, []);

  // Update URL without page reload
  const setUrlState = useCallback((state: UrlState) => {
    const params = new URLSearchParams();
    
    if (state.file) params.set('file', state.file);
    if (state.rollout !== undefined) params.set('rollout', state.rollout.toString());
    if (state.step !== undefined) params.set('step', state.step.toString());
    if (state.index !== undefined) params.set('index', state.index.toString());
    if (state.message !== undefined) params.set('message', state.message.toString());
    if (state.highlight) params.set('highlight', state.highlight);
    
    const newUrl = params.toString() 
      ? `${window.location.pathname}?${params.toString()}`
      : window.location.pathname;
    
    window.history.replaceState({}, '', newUrl);
  }, []);

  // Generate a shareable link
  const generateLink = useCallback((options: {
    file: string;
    rollout?: number;  // Use rollout_n as unique identifier
    step?: number;     // Disambiguate samples with same rollout_n
    index?: number;    // Sample's position within the file (for exact disambiguation)
    message?: number;
    highlight?: string;
  }): string => {
    const params = new URLSearchParams();

    params.set('file', options.file);
    if (options.rollout !== undefined) params.set('rollout', options.rollout.toString());
    if (options.step !== undefined) params.set('step', options.step.toString());
    if (options.index !== undefined) params.set('index', options.index.toString());
    if (options.message !== undefined) params.set('message', options.message.toString());
    if (options.highlight) params.set('highlight', options.highlight);
    
    return buildPublicUrl(params);
  }, []);

  return { getUrlState, setUrlState, generateLink };
}
