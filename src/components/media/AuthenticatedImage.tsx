import React, { useEffect, useRef, useState } from 'react';
import { useAuthenticatedMediaUrl } from '@/hooks/useAuthenticatedMediaUrl';
import { isTauriRuntime } from '@/platform/runtime';

interface AuthenticatedImageProps extends Omit<React.ImgHTMLAttributes<HTMLImageElement>, 'src'> {
  source: string;
  fallbackSource?: string;
  eager?: boolean;
  onAuthenticatedError?: (error: Error) => void;
}

export const AuthenticatedImage: React.FC<AuthenticatedImageProps> = ({
  source,
  fallbackSource,
  eager = false,
  onAuthenticatedError,
  onError,
  ...imageProps
}) => {
  const imageRef = useRef<HTMLImageElement>(null);
  const [activeSource, setActiveSource] = useState(source);
  const [shouldLoad, setShouldLoad] = useState(() => eager || !isTauriRuntime());
  const media = useAuthenticatedMediaUrl(activeSource, shouldLoad);

  useEffect(() => {
    setActiveSource(source);
  }, [source]);

  useEffect(() => {
    if (eager || !isTauriRuntime()) {
      setShouldLoad(true);
      return;
    }

    const element = imageRef.current;
    if (!element) return;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) {
        setShouldLoad(true);
        observer.disconnect();
      }
    }, { rootMargin: '300px' });
    observer.observe(element);
    return () => observer.disconnect();
  }, [eager]);

  useEffect(() => {
    if (!media.error) return;
    if (fallbackSource && activeSource !== fallbackSource) {
      setActiveSource(fallbackSource);
      return;
    }
    onAuthenticatedError?.(media.error);
  }, [activeSource, fallbackSource, media.error, onAuthenticatedError]);

  const handleError: React.ReactEventHandler<HTMLImageElement> = (event) => {
    if (fallbackSource && activeSource !== fallbackSource) {
      setActiveSource(fallbackSource);
      return;
    }
    onError?.(event);
  };

  return (
    <img
      {...imageProps}
      ref={imageRef}
      src={media.url}
      onError={handleError}
    />
  );
};
