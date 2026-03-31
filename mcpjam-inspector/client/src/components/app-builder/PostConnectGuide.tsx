import { motion } from "framer-motion";
import { ArrowDown } from "lucide-react";

const EASING: [number, number, number, number] = [0.16, 1, 0.3, 1];

export function PostConnectGuide() {
  return (
    <motion.div
      className="relative flex w-full flex-col items-center pb-4"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.35, ease: EASING }}
    >
      <p className="max-w-xl text-center text-lg font-medium text-foreground select-none">
        Try asking Excalidraw to draw something.
      </p>
      <motion.div
        className="text-foreground/50 mt-7"
        animate={{ y: [0, 5, 0] }}
        transition={{ duration: 1.8, repeat: Infinity, ease: "easeInOut" }}
      >
        <ArrowDown className="h-6 w-6" />
      </motion.div>
    </motion.div>
  );
}
