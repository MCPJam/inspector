/** Shared decorative artwork for sign-up and Free-plan upgrade dialogs. */
export function JamIllustration() {
  return (
    <img
      src="/guest-credit-wall.png"
      alt=""
      aria-hidden
      width={582}
      height={582}
      className="h-auto w-32 justify-self-start"
      onError={(event) => {
        event.currentTarget.style.display = "none";
      }}
    />
  );
}
