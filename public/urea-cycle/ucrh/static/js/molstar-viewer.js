/**
 * Mol* viewer bootstrap: load PDB from URL and optionally focus a residue (1-based seq index best-effort).
 */
(function () {
  function showFallback(el, msg) {
    if (!el) return;
    el.style.minHeight = '120px';
    el.innerHTML = '<p class="molstar-fallback">' + (msg || '3D structure could not be loaded.') + '</p>';
  }

  window.initMolstarViewer = function (options) {
    var elementId = options.elementId || 'molstar-root';
    var el = document.getElementById(elementId);
    if (!el) return;

    var pdbUrl = options.pdbUrl;
    var residue = options.residueIndex != null ? parseInt(options.residueIndex, 10) : null;

    if (typeof molstar === 'undefined') {
      showFallback(el, 'Mol* library failed to load from CDN.');
      return;
    }
    if (!pdbUrl) {
      showFallback(el, 'No structure file configured. Add a PDB under static/structures/&lt;GENE&gt;/.');
      return;
    }

    molstar.Viewer.create(elementId, {
      layoutIsExpanded: false,
      layoutShowControls: true,
      layoutShowSequence: true,
    })
      .then(function (viewer) {
        return viewer.loadStructureFromUrl(pdbUrl, 'pdb', false).then(function () {
          if (!residue || isNaN(residue)) return;
          try {
            if (viewer.plugin && viewer.plugin.managers && viewer.plugin.managers.structure) {
              viewer.visual.focus(residue);
            }
          } catch (e) {
            console.warn('Mol* residue focus:', e);
          }
        });
      })
      .catch(function (err) {
        console.error(err);
        showFallback(
          el,
          'Could not load PDB (file missing or network error). Expected file for this gene in static/structures/.'
        );
      });
  };
})();
