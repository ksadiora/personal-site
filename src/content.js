// Everything on the page lives here. Edit this file, not the markup.
// [text](url) becomes a link; everything else is plain text.
// Draft copy (2026-10-09): Karan should rewrite the lines in his own voice.
// Sources: resume rev. 3, the project repos' READMEs, and the Personal Site project notes.
// The scroll-driven resume version of this site is saved in ../personal-site-scroll.

export const person = {
  name: 'Karan Sadiora',
  email: 'karansadiora@email.virginia.edu',
  github: 'https://github.com/ksadiora',
  linkedin: 'https://linkedin.com/in/ksadiora',
  // The resume link shows only when this is set. Use a public copy of the resume (no phone number or
  // street address), saved in public/ and committed, e.g. public/resume.pdf → '/resume.pdf'.
  resumePdf: null,
};

export const hello = "hi, i'm karan.";

export const currently = [
  'currently studying neuroscience @ UVA. i research and build software for hospitals, labs and patients.',
];

// One line per dendrite, top branch first. Hovering a line sends an input down that branch.
export const previously = [
  // ksadiora/aftercare README; VTHacks 14, Sep 2026.
  'took 3rd overall at VTHacks 14 with [Aftercare](https://github.com/ksadiora/aftercare), a post-discharge check-in system for nurses and their patients',
  // BI-CTSICN/Urea_Cycle_App (private repo), Children's National, 2025–26. Links to the Morizono lab page.
  "built the urea cycle research hub at [Children's National](https://research.childrensnational.org/labs/morizono), which scores disease mutations and maps them onto 3D protein structures",
  // Resume: NRL SEAP 2025 (lateral flow immunoassays); Computational Molecular Bioscience 14(3), 2024.
  'built drug-detection assays at the U.S. Naval Research Lab, and [published a paper](https://doi.org/10.4236/cmb.2024.143005) on making protein drugs last longer',
  // Resume: Junior Medical Assistant, MedicsUSA (urgent + primary care), 2026.
  'worked 200+ hours as a medical assistant in urgent and primary care, rooming patients, giving injections and drawing blood',
  // ksadiora/eyespeak. The app itself runs on this site at /eyespeak/ (public/eyespeak, `npm run sync:eyespeak`).
  'made [EyeSpeak](/eyespeak/), which lets you type with only your eyes and a webcam ([code](https://github.com/ksadiora/eyespeak))',
];

export const also = [
  'i also founded [STEMLeap](https://stemleap.us), a STEM nonprofit that taught 200+ students.',
];

// The five dendrites, in the same order as `previously`. Dark-mode color, light-mode color.
export const inputs = [
  { id: 'a', color: '#ff5fb0', light: '#d6247a' },
  { id: 'b', color: '#49e08a', light: '#12925a' },
  { id: 'c', color: '#ffb547', light: '#bf7400' },
  { id: 'd', color: '#b38cff', light: '#7348d8' },
  { id: 'e', color: '#4f8dff', light: '#2a5fd6' },
];
