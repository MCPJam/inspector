import { motion } from "framer-motion";
import { XIcon } from "lucide-react";

const EASING: [number, number, number, number] = [0.16, 1, 0.3, 1];

interface PostConnectGuideProps {
  onDismiss: () => void;
}

export function PostConnectGuide({ onDismiss }: PostConnectGuideProps) {
  return (
    <motion.div
      className="absolute inset-0 z-10 flex items-center justify-center pointer-events-none"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.3, ease: EASING }}
    >
      <div className="pointer-events-auto relative max-w-sm bg-card border rounded-lg shadow-md p-6">
        {/* Close */}
        <button
          onClick={onDismiss}
          className="absolute top-2 right-2 rounded-full p-1 opacity-60 hover:opacity-100 transition-opacity focus:outline-none"
        >
          <XIcon className="h-3.5 w-3.5" />
          <span className="sr-only">Dismiss guide</span>
        </button>

        <p className="text-xs font-semibold text-primary uppercase tracking-wide mb-1">
          Temporary Guide
        </p>
        <h3 className="text-lg font-bold text-foreground mb-2">Step 1</h3>
        <p className="text-sm text-muted-foreground">
          Try your first prompt. We already filled this in for you so you can
          click send and watch Excalidraw render a diagram live.
        </p>
      </div>
    </motion.div>
  );
}
