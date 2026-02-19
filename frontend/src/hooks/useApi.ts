import { useState, useCallback } from 'react';
import type { Sample, FileInfo } from '../types';

interface SamplesResponse {
  samples: Sample[];
  total: number;
  experiment_name: string;
  file_path: string;
}

interface MultiFileSamplesResponse {
  samples: Sample[];
  total: number;
  experiment_name: string;
  file_paths: string[];
}

export function useApi() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadSamples = useCallback(async (filePath: string): Promise<SamplesResponse | null> => {
    setLoading(true);
    setError(null);
    
    try {
      const response = await fetch(`/api/samples?file=${encodeURIComponent(filePath)}`);
      if (!response.ok) {
        let detail = `Failed to load samples: ${response.status} ${response.statusText}`;
        try {
          const errorData = await response.json();
          detail = errorData.detail || detail;
        } catch { /* response body not JSON */ }
        throw new Error(detail);
      }
      const data = await response.json();
      return data;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  // Load multiple files and combine their samples
  const loadMultipleSamples = useCallback(async (filePaths: string[]): Promise<MultiFileSamplesResponse | null> => {
    if (filePaths.length === 0) return null;
    
    setLoading(true);
    setError(null);
    
    try {
      // Load all files in parallel
      const responses = await Promise.all(
        filePaths.map(async (filePath) => {
          const response = await fetch(`/api/samples?file=${encodeURIComponent(filePath)}`);
          if (!response.ok) {
            let detail = `${response.status} ${response.statusText}`;
            try {
              const errorData = await response.json();
              detail = errorData.detail || detail;
            } catch { /* response body not JSON */ }
            throw new Error(`Failed to load ${filePath}: ${detail}`);
          }
          return response.json() as Promise<SamplesResponse>;
        })
      );
      
      // Combine all samples with file source info
      let combinedSamples: Sample[] = [];
      let nextId = 0;
      
      for (let i = 0; i < responses.length; i++) {
        const data = responses[i];
        const filePath = filePaths[i];
        
        // Add file source to each sample and reassign IDs to be unique across all files
        const samplesWithSource = data.samples.map(sample => ({
          ...sample,
          id: nextId++,
          attributes: {
            ...sample.attributes,
            source_file: filePath, // Add which file this sample came from
          },
        }));
        
        combinedSamples = [...combinedSamples, ...samplesWithSource];
      }
      
      // Use the first file's experiment name, or combine them
      const experimentNames = [...new Set(responses.map(r => r.experiment_name).filter(Boolean))];
      const experimentName = experimentNames.length === 1 
        ? experimentNames[0] 
        : experimentNames.length > 1 
          ? `${experimentNames.length} experiments`
          : '';
      
      return {
        samples: combinedSamples,
        total: combinedSamples.length,
        experiment_name: experimentName,
        file_paths: filePaths,
      };
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  const listLocalFiles = useCallback(async (directory: string): Promise<FileInfo[]> => {
    setLoading(true);
    setError(null);
    
    try {
      const response = await fetch(`/api/files/local?directory=${encodeURIComponent(directory)}`);
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.detail || 'Failed to list files');
      }
      return await response.json();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
      return [];
    } finally {
      setLoading(false);
    }
  }, []);

  const listS3Files = useCallback(async (bucket: string, prefix: string): Promise<FileInfo[]> => {
    setLoading(true);
    setError(null);
    
    try {
      const response = await fetch(`/api/files/s3?bucket=${encodeURIComponent(bucket)}&prefix=${encodeURIComponent(prefix)}`);
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.detail || 'Failed to list S3 files');
      }
      return await response.json();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
      return [];
    } finally {
      setLoading(false);
    }
  }, []);

  return {
    loading,
    error,
    loadSamples,
    loadMultipleSamples,
    listLocalFiles,
    listS3Files,
  };
}
