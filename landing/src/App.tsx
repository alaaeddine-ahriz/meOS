import { Faq } from "./components/Faq.tsx";
import { Features } from "./components/Features.tsx";
import { FinalCta } from "./components/FinalCta.tsx";
import { Footer } from "./components/Footer.tsx";
import { Header } from "./components/Header.tsx";
import { Hero } from "./components/Hero.tsx";
import { Ecosystem, Providers } from "./components/Integrations.tsx";
import { Showcase } from "./components/Showcase.tsx";
import { Steps } from "./components/Steps.tsx";

export function App() {
  return (
    <div id="top" className="min-h-screen bg-bg text-text">
      <Header />
      {/* The left/right border frames the content like vite.dev. */}
      <main className="mx-auto max-w-6xl border-x border-border">
        <Hero />
        <Features />
        <Showcase />
        <Steps />
        <Providers />
        <Ecosystem />
        <Faq />
        <FinalCta />
      </main>
      <Footer />
    </div>
  );
}
