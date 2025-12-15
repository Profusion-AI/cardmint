import { useCallback, useRef } from 'react';

type SoundName = 'capture' | 'success' | 'flag';

/**
 * Hook for playing audio feedback sounds in the operator workbench
 *
 * Usage:
 *   const { play } = useAudioFeedback();
 *   play('capture'); // Play camera click sound
 */
export function useAudioFeedback() {
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // Initialize audio element on first use
  if (!audioRef.current) {
    audioRef.current = new Audio();
    audioRef.current.volume = 0.5; // Default volume (50%)
  }

  const play = useCallback((soundName: SoundName) => {
    if (audioRef.current) {
      audioRef.current.src = `/sounds/${soundName}.wav`;
      audioRef.current.currentTime = 0;
      audioRef.current.play().catch((error) => {
        // Audio playback may be blocked by browser autoplay policy
        // This is non-critical, so we just log to console
        console.log(`Audio feedback prevented for ${soundName}:`, error.message);
      });
    }
  }, []);

  const setVolume = useCallback((volume: number) => {
    if (audioRef.current) {
      audioRef.current.volume = Math.max(0, Math.min(1, volume));
    }
  }, []);

  return { play, setVolume };
}
