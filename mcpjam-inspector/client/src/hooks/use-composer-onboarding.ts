import { useState, useEffect, useCallback, useRef } from "react";
import { useReducedMotion } from "framer-motion";
import { useTypewriterString } from "./use-typewriter-string";

export interface UseComposerOnboardingOptions {
  initialInput?: string;
  initialInputTypewriter?: boolean;
  blockSubmitUntilServerConnected?: boolean;
  pulseSubmit?: boolean;
  showPostConnectGuide?: boolean;
  serverConnected: boolean;
  isThreadEmpty: boolean;
}

export interface UseComposerOnboardingReturn {
  input: string;
  setInput: (value: string) => void;
  handleInputChange: (nextInput: string) => void;
  isGuidedInputPristine: boolean;
  submitGatedByServer: boolean;
  sendNuxCtaVisible: boolean;
  sendButtonOnboardingPulse: boolean;
  moveCaretToEndTrigger: number | undefined;
  /** Call inside useChatSession's onReset callback. */
  onSessionReset: () => void;
  /** Call before resetChat() in handleClearChat to ensure the next onReset clears the composer. */
  prepareForClearChat: () => void;
}

export function useComposerOnboarding({
  initialInput,
  initialInputTypewriter = false,
  blockSubmitUntilServerConnected = false,
  pulseSubmit = false,
  showPostConnectGuide = false,
  serverConnected,
  isThreadEmpty,
}: UseComposerOnboardingOptions): UseComposerOnboardingReturn {
  const prefersReducedMotion = useReducedMotion();

  const [typewriterSupersededByUser, setTypewriterSupersededByUser] =
    useState(false);

  const [input, setInput] = useState(() =>
    initialInputTypewriter && initialInput && !showPostConnectGuide
      ? ""
      : (initialInput ?? ""),
  );

  const [guidedInputCursorTrigger, setGuidedInputCursorTrigger] = useState(0);

  const [isGuidedInputPristine, setIsGuidedInputPristine] = useState(
    showPostConnectGuide && !!initialInput,
  );

  const skipNextComposerClearFromSessionResetRef = useRef(false);

  // --- Typewriter ---

  const { text: typewriterText, isComplete: typewriterComplete } =
    useTypewriterString(initialInput ?? "", {
      active: Boolean(
        initialInput &&
        initialInputTypewriter &&
        !showPostConnectGuide &&
        !typewriterSupersededByUser,
      ),
      msPerChar: 20,
      reducedMotion: !!prefersReducedMotion,
    });

  // Reset superseded flag when typewriter props change
  useEffect(() => {
    if (!initialInput || !initialInputTypewriter) {
      setTypewriterSupersededByUser(false);
    }
  }, [initialInput, initialInputTypewriter]);

  // Move caret to end when typewriter finishes
  useEffect(() => {
    if (!initialInputTypewriter || showPostConnectGuide) return;
    if (!typewriterComplete) return;
    setGuidedInputCursorTrigger((current) => current + 1);
  }, [initialInputTypewriter, showPostConnectGuide, typewriterComplete]);

  // Sync typewriter text into input
  useEffect(() => {
    if (!initialInputTypewriter || showPostConnectGuide) return;
    if (typewriterSupersededByUser) return;
    setInput(typewriterText);
  }, [
    typewriterText,
    initialInputTypewriter,
    showPostConnectGuide,
    typewriterSupersededByUser,
  ]);

  // Non-typewriter initialInput seeding
  useEffect(() => {
    if (showPostConnectGuide || !initialInput || initialInputTypewriter) return;
    setInput((prev) => (prev === "" ? initialInput : prev));
  }, [initialInput, showPostConnectGuide, initialInputTypewriter]);

  // Post-connect guided prompt seeding
  useEffect(() => {
    if (showPostConnectGuide && initialInput) {
      setInput(initialInput);
      setIsGuidedInputPristine(true);
      setGuidedInputCursorTrigger((current) => current + 1);
      return;
    }
    setIsGuidedInputPristine(false);
  }, [initialInput, showPostConnectGuide]);

  // --- Callbacks ---

  const handleInputChange = useCallback(
    (nextInput: string) => {
      if (initialInputTypewriter && !showPostConnectGuide) {
        setTypewriterSupersededByUser(true);
      }
      setInput(nextInput);
      if (
        showPostConnectGuide &&
        isGuidedInputPristine &&
        nextInput !== initialInput
      ) {
        setIsGuidedInputPristine(false);
      }
    },
    [
      initialInput,
      isGuidedInputPristine,
      showPostConnectGuide,
      initialInputTypewriter,
    ],
  );

  const onSessionReset = useCallback(() => {
    if (showPostConnectGuide && isGuidedInputPristine && initialInput) {
      setInput((currentInput) => currentInput || initialInput);
      setGuidedInputCursorTrigger((current) => current + 1);
      return;
    }
    if (skipNextComposerClearFromSessionResetRef.current) {
      skipNextComposerClearFromSessionResetRef.current = false;
      setInput("");
      return;
    }
    if (initialInput && !showPostConnectGuide) {
      setInput((currentInput) => {
        if (currentInput === "" || currentInput === initialInput) {
          return initialInput;
        }
        return currentInput;
      });
      if (initialInputTypewriter) {
        setTypewriterSupersededByUser(false);
      }
      return;
    }
    setInput("");
  }, [
    showPostConnectGuide,
    isGuidedInputPristine,
    initialInput,
    initialInputTypewriter,
  ]);

  const prepareForClearChat = useCallback(() => {
    skipNextComposerClearFromSessionResetRef.current = true;
  }, []);

  // --- Computed ---

  const submitGatedByServer =
    blockSubmitUntilServerConnected && !serverConnected;

  const sendNuxCtaVisible =
    initialInputTypewriter && !showPostConnectGuide && isThreadEmpty;

  const sendButtonOnboardingPulse =
    pulseSubmit &&
    (isGuidedInputPristine ||
      (initialInputTypewriter &&
        !showPostConnectGuide &&
        isThreadEmpty &&
        !typewriterSupersededByUser));

  const moveCaretToEndTrigger =
    (showPostConnectGuide || initialInputTypewriter) && isThreadEmpty
      ? guidedInputCursorTrigger
      : undefined;

  return {
    input,
    setInput,
    handleInputChange,
    isGuidedInputPristine,
    submitGatedByServer,
    sendNuxCtaVisible,
    sendButtonOnboardingPulse,
    moveCaretToEndTrigger,
    onSessionReset,
    prepareForClearChat,
  };
}
