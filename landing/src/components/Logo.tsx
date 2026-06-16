/** Small node-cluster mark — a nod to the knowledge graph. */
export function Logo({ className = "" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 32 32"
      className={className}
      fill="none"
      aria-hidden="true"
      role="img"
    >
      <line x1="16" y1="16" x2="26" y2="8" stroke="currentColor" strokeWidth="1.5" opacity="0.6" />
      <line x1="16" y1="16" x2="6" y2="24" stroke="currentColor" strokeWidth="1.5" opacity="0.6" />
      <circle cx="16" cy="16" r="6" fill="currentColor" />
      <circle cx="26" cy="8" r="2.5" fill="currentColor" />
      <circle cx="6" cy="24" r="2.5" fill="currentColor" />
    </svg>
  );
}
