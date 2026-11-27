/**
 * Activa el layout inmersivo antes de cargar las hojas de estilo.
 * @module
 */
(function activarLayoutInmersivo() {
  const modoInicial = new URLSearchParams(window.location.search).get('modo');
  if (['repaso', 'falladas', 'tema'].includes(modoInicial)) {
    document.documentElement.classList.add(`modo-${modoInicial}`);
  }
})();
