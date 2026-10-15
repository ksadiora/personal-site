/**
 * Urea Cycle Research Hub - Main front-end script.
 *
 * Handles gene pages and custom search: keywords panel, load more papers, sort/export,
 * like/dislike and comments on papers, and "new papers since last visit" modal.
 * Only runs on pages that have the keywords panel (gene pages and custom search).
 */
document.addEventListener("DOMContentLoaded", () => {
  // DOM elements for keywords panel and paper list
  const toggleBtn = document.getElementById('toggle-keywords');
  const panel = document.getElementById('keywords-panel');
  const addBtn = document.getElementById('add-keywords');
  const currentList = document.getElementById('current-keywords');
  const newInput = document.getElementById('new-keywords');
  const loadMoreBtn = document.getElementById('load-more');
  const showAllBtn = document.getElementById('show-all');
  const papersList = document.getElementById('papers-list');
  const loadingText = document.getElementById('loading-text');
  const sortSelect = document.getElementById('sort-select');

  // Only proceed if we're on a page with these elements (like OTC page)
  if (!toggleBtn || !panel) {
      return; // Exit early if not on gene page
  }

  let offset = papersList ? papersList.children.length : 0; // initial papers shown
  const defaultLimit = 10;
  
  // Get default keywords from the sidebar (first items before extra keywords)
  function getDefaultKeywords() {
      if (!currentList) return [];
      const allKeywords = Array.from(currentList.children).map(li => li.textContent.trim());
      return allKeywords;
  }
  
  // Default keywords in lowercase for case-insensitive comparison
  // Will be populated from the sidebar on page load
  let defaultKeywordsLower = [];
  
  // Initialize default keywords from sidebar
  if (currentList) {
      const allKeywords = Array.from(currentList.children).map(li => li.textContent.trim());
      defaultKeywordsLower = allKeywords.map(kw => kw.toLowerCase());
  }

  function showLoading(show) {
      if (loadingText) loadingText.style.display = show ? "block" : "none";
  }

  // Get current gene name from URL
  function getCurrentGene() {
      const path = window.location.pathname;
      const match = path.match(/\/([A-Z0-9]+)(?:\/|$)/);
      return match ? match[1] : 'OTC'; // Default to OTC if can't determine
  }

  // Get extra keywords (excluding the default ones) - case insensitive
  function getExtraKeywords() {
      if (!currentList) return [];
      const allKeywords = Array.from(currentList.children).map(li => li.textContent.trim());
      // The default keywords are the first 4 items (urea cycle, ureagenesis, gene-specific terms)
      // Everything after that is extra keywords
      const defaultCount = 4; // urea cycle, ureagenesis, and 2 gene-specific terms
      return allKeywords.slice(defaultCount);
  }

  // Check if a keyword is a default keyword (case-insensitive)
  // Default keywords are always the first 4 items in the list
  function isDefaultKeyword(keyword) {
      if (!currentList) return false;
      const allKeywords = Array.from(currentList.children).map(li => li.textContent.trim());
      const defaultCount = 4; // urea cycle, ureagenesis, and 2 gene-specific terms
      const defaultKeywords = allKeywords.slice(0, defaultCount);
      return defaultKeywords.some(kw => kw.toLowerCase() === keyword.toLowerCase());
  }

  // Get current sort option
  function getSortOption() {
      return sortSelect ? sortSelect.value : 'date';
  }

  const VARIANT_GENES_WITH_EXPLORER = ['OTC', 'CPS1', 'NAGS', 'ASS', 'ASL', 'ARG1', 'ORNT1', 'CITRIN'];

  /** HTML for "Variants mentioned" (matches server-rendered partial). */
  function variantsMentionedBlock(paper, gene) {
      if (!VARIANT_GENES_WITH_EXPLORER.includes(gene)) return '';
      const vars = paper.variants_mentioned;
      if (!vars || !vars.length) return '';
      const links = vars.map(
          (v) =>
              `<a href="/urea-cycle/ucrh/variants/${gene}/${encodeURIComponent(v)}" style="margin-right: 0.5rem; white-space: nowrap;">${v}</a>`
      ).join(', ');
      return `<div class="paper-variants-mentioned" style="margin-top: 0.75rem; padding: 0.5rem 0.75rem; background: #f0f7fb; border-radius: 6px; font-size: 0.9rem;"><strong>Variants mentioned:</strong> ${links}</div>`;
  }

  // Build URL for AJAX fetch
  function buildURL(limit = defaultLimit) {
      const gene = getCurrentGene();
      const extra = getExtraKeywords().join(',');
      const sort = getSortOption();
      return `/urea-cycle/ucrh/${gene}/load_more?offset=${offset}&limit=${limit}&extra=${encodeURIComponent(extra)}&sort=${sort}`;
  }

  // Fetch papers via AJAX and append to list
  async function fetchPapers(limit = defaultLimit) {
      if (!papersList) return;
      
      showLoading(true);
      try {
          const response = await fetch(buildURL(limit));
          if (!response.ok) {
              throw new Error(`HTTP error! status: ${response.status}`);
          }
          const data = await response.json();

          if (data.length === 0) {
              // No more papers
              const noMoreMsg = document.createElement('p');
              noMoreMsg.textContent = 'No more papers to display.';
              noMoreMsg.style.textAlign = 'center';
              noMoreMsg.style.color = '#666';
              papersList.parentNode.insertBefore(noMoreMsg, papersList.nextSibling);
              return;
          }

          const gene = getCurrentGene();
          data.forEach(paper => {
              const li = document.createElement("li");
              li.style.marginBottom = "1.5em";
              li.style.paddingBottom = "1em";
              li.style.borderBottom = "1px solid #eee";
              
              const userInteraction = paper.user_interaction || '';
              const likeActive = userInteraction === 'like' ? '#4CAF50' : '#e0e0e0';
              const likeTextColor = userInteraction === 'like' ? 'white' : 'black';
              const dislikeActive = userInteraction === 'dislike' ? '#f44336' : '#e0e0e0';
              const dislikeTextColor = userInteraction === 'dislike' ? 'white' : 'black';
              
              li.innerHTML = `
                  <strong><a href="${paper.link}" target="_blank" style="text-decoration:none; color:#003366;">
                      ${paper.title}
                  </a></strong><br>
                  <em>${paper.journal}</em>, ${paper.date}, Vol. ${paper.volume}, pp. ${paper.pages}<br>
                  <small>PMID: <a href="${paper.link}" target="_blank">${paper.pmid}</a> | PMCID: ${paper.pmcid}</small>
                  <p>${paper.abstract}</p>
                  ${variantsMentionedBlock(paper, gene)}
                  
                  <div style="margin-top: 10px; display: flex; gap: 15px; align-items: center; flex-wrap: wrap;">
                      <button class="like-btn" data-pmid="${paper.pmid}" 
                              style="padding: 5px 12px; background-color: ${likeActive}; 
                                     color: ${likeTextColor}; 
                                     border: none; border-radius: 4px; cursor: pointer; font-size: 14px;">
                          👍 Like (<span class="like-count">${paper.likes || 0}</span>)
                      </button>
                      <button class="dislike-btn" data-pmid="${paper.pmid}" 
                              style="padding: 5px 12px; background-color: ${dislikeActive}; 
                                     color: ${dislikeTextColor}; 
                                     border: none; border-radius: 4px; cursor: pointer; font-size: 14px;">
                          👎 Dislike (<span class="dislike-count">${paper.dislikes || 0}</span>)
                      </button>
                      <button class="comment-btn" data-pmid="${paper.pmid}" 
                              style="padding: 5px 12px; background-color: #284b63; color: white; 
                                     border: none; border-radius: 4px; cursor: pointer; font-size: 14px;">
                          💬 Comment (<span class="comment-count">${paper.comments || 0}</span>)
                      </button>
                  </div>
                  
                  <div class="comments-section" id="comments-${paper.pmid}" style="display: none; margin-top: 15px; padding: 10px; background-color: #f9f9f9; border-radius: 4px;">
                      <h5 style="margin-top: 0;">Comments:</h5>
                      <div class="comments-list" id="comments-list-${paper.pmid}"></div>
                      <div style="margin-top: 10px;">
                          <textarea class="comment-input" data-pmid="${paper.pmid}" 
                                    placeholder="Add a comment..." 
                                    style="width: 100%; min-height: 60px; padding: 8px; border: 1px solid #ccc; border-radius: 4px; font-family: inherit; font-size: 14px;"></textarea>
                          <button class="submit-comment-btn" data-pmid="${paper.pmid}" 
                                  style="margin-top: 5px; padding: 6px 12px; background-color: #284b63; color: white; 
                                         border: none; border-radius: 4px; cursor: pointer; font-size: 14px;">
                              Submit Comment
                          </button>
                      </div>
                  </div>
              `;
              papersList.appendChild(li);
          });
          
          offset += data.length;
          
          // Attach event listeners to newly added buttons
          attachInteractionListeners();
      } catch (error) {
          console.error("Error fetching papers:", error);
          alert("Error fetching papers. Please try again.");
      } finally {
          showLoading(false);
      }
  }

  // Sidebar toggle
  toggleBtn.addEventListener('click', (e) => {
      e.preventDefault();
      const isHidden = panel.style.display === 'none' || panel.style.display === '';
      panel.style.display = isHidden ? 'block' : 'none';
  });

  // Close button for sidebar
  const closeBtn = document.getElementById('close-keywords');
  if (closeBtn && panel) {
      closeBtn.addEventListener('click', (e) => {
          e.preventDefault();
          panel.style.display = 'none';
      });
  }

  // Add new keywords - reload page with new keywords in URL
  if (addBtn && newInput && currentList) {
      addBtn.addEventListener('click', () => {
          const input = newInput.value.trim();
          if (!input) return;

          // Parse and clean keywords
          const newKeywords = input.split(',')
              .map(k => k.trim())
              .filter(k => k.length > 0)
              .filter(k => !isDefaultKeyword(k)); // Filter out default keywords
          
          if (newKeywords.length === 0) {
              alert('All keywords were filtered out (they are already default keywords).');
              newInput.value = '';
              return;
          }
          
          // Get current extra keywords from URL or sidebar
          const currentExtra = getExtraKeywords();
          
          // Combine and remove duplicates (case-insensitive)
          const allExtra = [...currentExtra];
          newKeywords.forEach(kw => {
              // Check if keyword already exists (case-insensitive)
              const exists = allExtra.some(existing => existing.toLowerCase() === kw.toLowerCase());
              if (!exists) {
                  allExtra.push(kw);
              }
          });
          
          // Save keywords to database
          const gene = getCurrentGene();
          const geneForApi = gene === 'custom' ? 'custom' : gene;
          
          fetch('/urea-cycle/ucrh/api/keywords/save', {
              method: 'POST',
              headers: {
                  'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                  gene_name: geneForApi === 'custom' ? null : geneForApi,
                  keywords: allExtra,
                  is_default: false
              })
          }).then(response => response.json())
          .then(data => {
              // Build new URL with all extra keywords and preserve sort
              const extraParam = allExtra.join(',');
              const sort = getSortOption();
              const newURL = `/urea-cycle/ucrh/${gene}?extra=${encodeURIComponent(extraParam)}&sort=${sort}`;
              
              // Reload page with new keywords - this will trigger a fresh query
              window.location.href = newURL;
          })
          .catch(error => {
              console.error('Error saving keywords:', error);
              // Still reload page even if save fails
              const extraParam = allExtra.join(',');
              const sort = getSortOption();
              const newURL = `/urea-cycle/ucrh/${gene}?extra=${encodeURIComponent(extraParam)}&sort=${sort}`;
              window.location.href = newURL;
          });
      });
  }

  // Show More button
  if (loadMoreBtn) {
      loadMoreBtn.addEventListener('click', () => fetchPapers(defaultLimit));
  }

  // Show All button
  if (showAllBtn) {
      showAllBtn.addEventListener('click', () => fetchPapers(100));
  }

  // Export button and menu
  const exportBtn = document.getElementById('export-btn');
  const exportMenu = document.getElementById('export-menu');
  const exportRis = document.getElementById('export-ris');
  const exportPmid = document.getElementById('export-pmid');
  
  if (exportBtn && exportMenu) {
      // Toggle menu on button click
      exportBtn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          exportMenu.style.display = exportMenu.style.display === 'none' ? 'block' : 'none';
      });
      
      // Close menu when clicking outside
      document.addEventListener('click', (e) => {
          if (!exportBtn.contains(e.target) && !exportMenu.contains(e.target)) {
              exportMenu.style.display = 'none';
          }
      });
      
      // Handle export clicks
      if (exportRis) {
          exportRis.addEventListener('click', (e) => {
              e.preventDefault();
              const path = window.location.pathname;
              const isCustom = path === '/urea-cycle/ucrh/custom' || path.startsWith('/urea-cycle/ucrh/custom/');
              
              if (isCustom) {
                  // Custom search - get keywords from URL
                  const urlParams = new URLSearchParams(window.location.search);
                  const keywords = urlParams.get('keywords') || '';
                  const url = `/urea-cycle/ucrh/export/custom/ris?keywords=${encodeURIComponent(keywords)}`;
                  window.location.href = url;
              } else {
                  // Gene page
                  const gene = getCurrentGene();
                  const extra = getExtraKeywords().join(',');
                  const url = `/urea-cycle/ucrh/export/${gene}/ris?extra=${encodeURIComponent(extra)}`;
                  window.location.href = url;
              }
              exportMenu.style.display = 'none';
          });
      }
      
      if (exportPmid) {
          exportPmid.addEventListener('click', (e) => {
              e.preventDefault();
              const path = window.location.pathname;
              const isCustom = path === '/urea-cycle/ucrh/custom' || path.startsWith('/urea-cycle/ucrh/custom/');
              
              if (isCustom) {
                  // Custom search - get keywords from URL
                  const urlParams = new URLSearchParams(window.location.search);
                  const keywords = urlParams.get('keywords') || '';
                  const url = `/urea-cycle/ucrh/export/custom/pmid?keywords=${encodeURIComponent(keywords)}`;
                  window.location.href = url;
              } else {
                  // Gene page
                  const gene = getCurrentGene();
                  const extra = getExtraKeywords().join(',');
                  const url = `/urea-cycle/ucrh/export/${gene}/pmid?extra=${encodeURIComponent(extra)}`;
                  window.location.href = url;
              }
              exportMenu.style.display = 'none';
          });
      }
  }

  // Sort dropdown handler
  if (sortSelect) {
      sortSelect.addEventListener('change', () => {
          const gene = getCurrentGene();
          const sort = sortSelect.value;
          const extra = getExtraKeywords().join(',');
          const newURL = `/urea-cycle/ucrh/${gene}?extra=${encodeURIComponent(extra)}&sort=${sort}`;
          window.location.href = newURL;
      });
  }

  // Interaction handlers
  function attachInteractionListeners() {
      // Like buttons
      document.querySelectorAll('.like-btn').forEach(btn => {
          if (btn.dataset.listenerAttached) return;
          btn.dataset.listenerAttached = 'true';
          btn.addEventListener('click', async function() {
              const pmid = this.getAttribute('data-pmid');
              try {
                  const response = await fetch(`/urea-cycle/ucrh/api/paper/${pmid}/like`, {
                      method: 'POST'
                  });
                  
                  if (response.status === 401) {
                      alert('Please log in to like papers.');
                      window.location.href = '/urea-cycle/ucrh/login';
                      return;
                  }
                  
                  const data = await response.json();
                  
                  // Update counts
                  const likeCount = this.querySelector('.like-count');
                  const dislikeBtn = document.querySelector(`.dislike-btn[data-pmid="${pmid}"]`);
                  const dislikeCount = dislikeBtn ? dislikeBtn.querySelector('.dislike-count') : null;
                  
                  const oldLikeCount = parseInt(likeCount.textContent);
                  const newLikeCount = parseInt(data.likes);
                  
                  if (likeCount) likeCount.textContent = data.likes;
                  if (dislikeCount) dislikeCount.textContent = data.dislikes;
                  
                  // Toggle button state: if count increased, user liked; if decreased, user unliked
                  if (newLikeCount > oldLikeCount) {
                      // User just liked
                      this.style.backgroundColor = '#4CAF50';
                      this.style.color = 'white';
                      // Turn off dislike if active
                      if (dislikeBtn) {
                          dislikeBtn.style.backgroundColor = '#e0e0e0';
                          dislikeBtn.style.color = 'black';
                      }
                  } else if (newLikeCount < oldLikeCount) {
                      // User just unliked
                      this.style.backgroundColor = '#e0e0e0';
                      this.style.color = 'black';
                  }
              } catch (error) {
                  console.error('Error liking paper:', error);
                  alert('Error updating like. Please try again.');
              }
          });
      });

      // Dislike buttons
      document.querySelectorAll('.dislike-btn').forEach(btn => {
          if (btn.dataset.listenerAttached) return;
          btn.dataset.listenerAttached = 'true';
          btn.addEventListener('click', async function() {
              const pmid = this.getAttribute('data-pmid');
              try {
                  const response = await fetch(`/urea-cycle/ucrh/api/paper/${pmid}/dislike`, {
                      method: 'POST'
                  });
                  
                  if (response.status === 401) {
                      alert('Please log in to dislike papers.');
                      window.location.href = '/urea-cycle/ucrh/login';
                      return;
                  }
                  
                  const data = await response.json();
                  
                  // Update counts
                  const dislikeCount = this.querySelector('.dislike-count');
                  const likeBtn = document.querySelector(`.like-btn[data-pmid="${pmid}"]`);
                  const likeCount = likeBtn ? likeBtn.querySelector('.like-count') : null;
                  
                  const oldDislikeCount = parseInt(dislikeCount.textContent);
                  const newDislikeCount = parseInt(data.dislikes);
                  
                  if (dislikeCount) dislikeCount.textContent = data.dislikes;
                  if (likeCount) likeCount.textContent = data.likes;
                  
                  // Toggle button state: if count increased, user disliked; if decreased, user removed dislike
                  if (newDislikeCount > oldDislikeCount) {
                      // User just disliked
                      this.style.backgroundColor = '#f44336';
                      this.style.color = 'white';
                      // Turn off like if active
                      if (likeBtn) {
                          likeBtn.style.backgroundColor = '#e0e0e0';
                          likeBtn.style.color = 'black';
                      }
                  } else if (newDislikeCount < oldDislikeCount) {
                      // User just removed dislike
                      this.style.backgroundColor = '#e0e0e0';
                      this.style.color = 'black';
                  }
              } catch (error) {
                  console.error('Error disliking paper:', error);
                  alert('Error updating dislike. Please try again.');
              }
          });
      });

      // Comment buttons
      document.querySelectorAll('.comment-btn').forEach(btn => {
          if (btn.dataset.listenerAttached) return;
          btn.dataset.listenerAttached = 'true';
          btn.addEventListener('click', async function() {
              const pmid = this.getAttribute('data-pmid');
              const commentsSection = document.getElementById(`comments-${pmid}`);
              
              if (commentsSection.style.display === 'none') {
                  commentsSection.style.display = 'block';
                  // Load comments
                  await loadComments(pmid);
              } else {
                  commentsSection.style.display = 'none';
              }
          });
      });

      // Submit comment buttons
      document.querySelectorAll('.submit-comment-btn').forEach(btn => {
          if (btn.dataset.listenerAttached) return;
          btn.dataset.listenerAttached = 'true';
          btn.addEventListener('click', async function() {
              const pmid = this.getAttribute('data-pmid');
              const textarea = document.querySelector(`.comment-input[data-pmid="${pmid}"]`);
              const commentText = textarea ? textarea.value.trim() : '';
              
              if (!commentText) {
                  alert('Please enter a comment.');
                  return;
              }
              
              try {
                  const response = await fetch(`/urea-cycle/ucrh/api/paper/${pmid}/comment`, {
                      method: 'POST',
                      headers: {
                          'Content-Type': 'application/json'
                      },
                      body: JSON.stringify({ comment: commentText })
                  });
                  
                  if (response.status === 401) {
                      alert('Please log in to post comments.');
                      window.location.href = '/urea-cycle/ucrh/login';
                      return;
                  }
                  
                  if (!response.ok) {
                      throw new Error('Failed to submit comment');
                  }
                  
                  const data = await response.json();
                  textarea.value = '';
                  await loadComments(pmid);
                  
                  // Update comment count
                  const commentCount = document.querySelector(`.comment-btn[data-pmid="${pmid}"] .comment-count`);
                  if (commentCount) {
                      commentCount.textContent = data.comments.length;
                  }
              } catch (error) {
                  console.error('Error submitting comment:', error);
                  alert('Error submitting comment. Please try again.');
              }
          });
      });
  }

  // Load comments for a paper
  async function loadComments(pmid) {
      const commentsList = document.getElementById(`comments-list-${pmid}`);
      if (!commentsList) return;
      
      try {
          const response = await fetch(`/urea-cycle/ucrh/api/paper/${pmid}/comments`);
          const data = await response.json();
          
          // Update comment count
          const commentCount = document.querySelector(`.comment-btn[data-pmid="${pmid}"] .comment-count`);
          if (commentCount) {
              commentCount.textContent = data.comments ? data.comments.length : 0;
          }
          
          const currentUserId = data.current_user_id;
          const isAdmin = data.is_admin || false;
          
          if (data.comments && data.comments.length > 0) {
              commentsList.innerHTML = data.comments.map(comment => {
                  const date = new Date(comment.created_at);
                  const isOwner = comment.user_id == currentUserId; // Use == for type coercion
                  const canDelete = isOwner || isAdmin;
                  const deleteBtn = canDelete ? `
                      <button class="delete-paper-comment-btn" data-pmid="${pmid}" data-comment-id="${comment.id}" 
                              style="padding: 4px 8px; background-color: #dc3545; color: white; 
                                     border: none; border-radius: 4px; cursor: pointer; font-size: 12px; margin-left: 10px;">
                          ${isAdmin && !isOwner ? '🗑️ Admin Delete' : 'Delete'}
                      </button>
                  ` : '';
                  
                  const likeActive = comment.user_interaction === 'like' ? '#4CAF50' : '#e0e0e0';
                  const likeTextColor = comment.user_interaction === 'like' ? 'white' : 'black';
                  const dislikeActive = comment.user_interaction === 'dislike' ? '#f44336' : '#e0e0e0';
                  const dislikeTextColor = comment.user_interaction === 'dislike' ? 'white' : 'black';
                  
                  return `
                      <div style="margin-bottom: 10px; padding: 8px; background-color: white; border-radius: 4px; border-left: 3px solid #C8102E;">
                          <div style="display: flex; justify-content: space-between; align-items: start;">
                              <div style="flex: 1;">
                                  <p style="margin: 0 0 5px 0;">${comment.comment_text}</p>
                                  <small style="color: #666;">${date.toLocaleDateString()} ${date.toLocaleTimeString()} by <strong style="color: #C8102E;">${comment.username || 'Unknown'}</strong></small>
                                  <div style="margin-top: 8px; display: flex; gap: 8px; align-items: center;">
                                      <button class="comment-like-btn" data-comment-id="${comment.id}" 
                                              style="padding: 3px 8px; background-color: ${likeActive}; 
                                                     color: ${likeTextColor}; 
                                                     border: none; border-radius: 4px; cursor: pointer; font-size: 12px;">
                                          👍 (<span class="comment-like-count">${comment.likes || 0}</span>)
                                      </button>
                                      <button class="comment-dislike-btn" data-comment-id="${comment.id}" 
                                              style="padding: 3px 8px; background-color: ${dislikeActive}; 
                                                     color: ${dislikeTextColor}; 
                                                     border: none; border-radius: 4px; cursor: pointer; font-size: 12px;">
                                          👎 (<span class="comment-dislike-count">${comment.dislikes || 0}</span>)
                                      </button>
                                  </div>
                              </div>
                              ${deleteBtn}
                          </div>
                      </div>
                  `;
              }).join('');
              
              // Add event listeners to comment like/dislike buttons
              commentsList.querySelectorAll('.comment-like-btn').forEach(btn => {
                  btn.addEventListener('click', async function() {
                      const commentId = this.dataset.commentId;
                      try {
                          const response = await fetch(`/urea-cycle/ucrh/api/comments/${commentId}/like`, {
                              method: 'POST'
                          });
                          
                          if (response.status === 401) {
                              alert('Please log in to like comments.');
                              window.location.href = '/urea-cycle/ucrh/login';
                              return;
                          }
                          
                          const data = await response.json();
                          
                          // Update counts and button styles
                          const likeCount = this.querySelector('.comment-like-count');
                          const dislikeBtn = document.querySelector(`.comment-dislike-btn[data-comment-id="${commentId}"]`);
                          const dislikeCount = dislikeBtn ? dislikeBtn.querySelector('.comment-dislike-count') : null;
                          
                          if (likeCount) likeCount.textContent = data.likes || 0;
                          if (dislikeCount) dislikeCount.textContent = data.dislikes || 0;
                          
                          // Update button styles
                          if (data.user_interaction === 'like') {
                              this.style.backgroundColor = '#4CAF50';
                              this.style.color = 'white';
                              if (dislikeBtn) {
                                  dislikeBtn.style.backgroundColor = '#e0e0e0';
                                  dislikeBtn.style.color = 'black';
                              }
                          } else {
                              this.style.backgroundColor = '#e0e0e0';
                              this.style.color = 'black';
                          }
                      } catch (error) {
                          console.error('Error liking comment:', error);
                      }
                  });
              });
              
              commentsList.querySelectorAll('.comment-dislike-btn').forEach(btn => {
                  btn.addEventListener('click', async function() {
                      const commentId = this.dataset.commentId;
                      try {
                          const response = await fetch(`/urea-cycle/ucrh/api/comments/${commentId}/dislike`, {
                              method: 'POST'
                          });
                          
                          if (response.status === 401) {
                              alert('Please log in to dislike comments.');
                              window.location.href = '/urea-cycle/ucrh/login';
                              return;
                          }
                          
                          const data = await response.json();
                          
                          // Update counts and button styles
                          const dislikeCount = this.querySelector('.comment-dislike-count');
                          const likeBtn = document.querySelector(`.comment-like-btn[data-comment-id="${commentId}"]`);
                          const likeCount = likeBtn ? likeBtn.querySelector('.comment-like-count') : null;
                          
                          if (dislikeCount) dislikeCount.textContent = data.dislikes || 0;
                          if (likeCount) likeCount.textContent = data.likes || 0;
                          
                          // Update button styles
                          if (data.user_interaction === 'dislike') {
                              this.style.backgroundColor = '#f44336';
                              this.style.color = 'white';
                              if (likeBtn) {
                                  likeBtn.style.backgroundColor = '#e0e0e0';
                                  likeBtn.style.color = 'black';
                              }
                          } else {
                              this.style.backgroundColor = '#e0e0e0';
                              this.style.color = 'black';
                          }
                      } catch (error) {
                          console.error('Error disliking comment:', error);
                      }
                  });
              });
              
              // Add event listeners to delete comment buttons
              commentsList.querySelectorAll('.delete-paper-comment-btn').forEach(btn => {
                  btn.addEventListener('click', async function() {
                      const commentId = this.dataset.commentId;
                      const paperPmid = this.dataset.pmid;
                      
                      if (!confirm('Are you sure you want to delete this comment?')) {
                          return;
                      }
                      
                      try {
                          const response = await fetch(`/urea-cycle/ucrh/api/paper/${paperPmid}/comments/${commentId}`, {
                              method: 'DELETE'
                          });
                          
                          const data = await response.json();
                          if (data.success) {
                              // Reload comments
                              await loadComments(paperPmid);
                              
                              // Update comment count
                              const commentCount = document.querySelector(`.comment-btn[data-pmid="${paperPmid}"] .comment-count`);
                              if (commentCount) {
                                  commentCount.textContent = data.comments ? data.comments.length : 0;
                              }
                          } else {
                              alert(data.error || 'Error deleting comment');
                          }
                      } catch (error) {
                          console.error('Error deleting comment:', error);
                          alert('Error deleting comment. Please try again.');
                      }
                  });
              });
          } else {
              commentsList.innerHTML = '<p style="color: #666; font-style: italic;">No comments yet. Be the first to comment!</p>';
          }
      } catch (error) {
          console.error('Error loading comments:', error);
          commentsList.innerHTML = '<p style="color: #f44336;">Error loading comments.</p>';
      }
  }

  // Attach listeners to initial papers
  attachInteractionListeners();

  // New papers modal functionality
  const newPapersLink = document.getElementById('new-papers-link');
  const newPapersModal = document.getElementById('new-papers-modal');
  const closeModalBtn = document.getElementById('close-modal');
  const newPapersContent = document.getElementById('new-papers-content');

  function renderPaperInModal(paper) {
      const likeActive = paper.user_interaction === 'like' ? '#4CAF50' : '#e0e0e0';
      const likeTextColor = paper.user_interaction === 'like' ? 'white' : 'black';
      const dislikeActive = paper.user_interaction === 'dislike' ? '#f44336' : '#e0e0e0';
      const dislikeTextColor = paper.user_interaction === 'dislike' ? 'white' : 'black';

      return `
          <li style="margin-bottom: 1.5em; padding-bottom: 1em; border-bottom: 1px solid #eee;">
              <strong>
                  <a href="${paper.link}" target="_blank" style="text-decoration: none; color: #003366;">
                      ${paper.title}
                  </a>
              </strong><br>
              <em>${paper.journal}</em>, ${paper.date || paper.year || 'N/A'}, Vol. ${paper.volume}, pp. ${paper.pages}<br>
              <small>PMID: <a href="${paper.link}" target="_blank">${paper.pmid}</a> | PMCID: ${paper.pmcid}</small>
              <p>${paper.abstract}</p>
              
              <div style="margin-top: 10px; display: flex; gap: 15px; align-items: center; flex-wrap: wrap;">
                  <button class="modal-like-btn" data-pmid="${paper.pmid}" 
                          style="padding: 5px 12px; background-color: ${likeActive}; 
                                 color: ${likeTextColor}; 
                                 border: none; border-radius: 4px; cursor: pointer; font-size: 14px;">
                      👍 Like (<span class="like-count">${paper.likes || 0}</span>)
                  </button>
                  <button class="modal-dislike-btn" data-pmid="${paper.pmid}" 
                          style="padding: 5px 12px; background-color: ${dislikeActive}; 
                                 color: ${dislikeTextColor}; 
                                 border: none; border-radius: 4px; cursor: pointer; font-size: 14px;">
                      👎 Dislike (<span class="dislike-count">${paper.dislikes || 0}</span>)
                  </button>
                  <button class="modal-comment-btn" data-pmid="${paper.pmid}" 
                          style="padding: 5px 12px; background-color: #284b63; color: white; 
                                 border: none; border-radius: 4px; cursor: pointer; font-size: 14px;">
                      💬 Comment (<span class="comment-count">${paper.comments || 0}</span>)
                  </button>
              </div>
              
              <div class="modal-comments-section" id="modal-comments-${paper.pmid}" style="display: none; margin-top: 15px; padding: 10px; background-color: #f9f9f9; border-radius: 4px;">
                  <h5 style="margin-top: 0;">Comments:</h5>
                  <div class="modal-comments-list" id="modal-comments-list-${paper.pmid}"></div>
                  <div style="margin-top: 10px;">
                      <textarea class="modal-comment-input" data-pmid="${paper.pmid}" 
                                placeholder="Add a comment..." 
                                style="width: 100%; min-height: 60px; padding: 8px; border: 1px solid #ccc; border-radius: 4px; font-family: inherit; font-size: 14px;"></textarea>
                      <button class="modal-submit-comment-btn" data-pmid="${paper.pmid}" 
                              style="margin-top: 5px; padding: 6px 12px; background-color: #284b63; color: white; 
                                     border: none; border-radius: 4px; cursor: pointer; font-size: 14px;">
                          Submit Comment
                      </button>
                  </div>
              </div>
          </li>
      `;
  }

  function attachModalInteractionListeners() {
      // Like buttons in modal
      document.querySelectorAll('.modal-like-btn').forEach(btn => {
          btn.addEventListener('click', async function() {
              const pmid = this.dataset.pmid;
              try {
                  const response = await fetch(`/urea-cycle/ucrh/api/paper/${pmid}/like`, { method: 'POST' });
                  const data = await response.json();
                  
                  // Update counts in modal
                  const likeCount = this.querySelector('.like-count');
                  const dislikeCount = document.querySelector(`.modal-dislike-btn[data-pmid="${pmid}"] .dislike-count`);
                  if (likeCount) likeCount.textContent = data.likes || 0;
                  if (dislikeCount) dislikeCount.textContent = data.dislikes || 0;
                  
                  // Update button styles
                  if (data.likes > (parseInt(likeCount.textContent) || 0)) {
                      this.style.backgroundColor = '#4CAF50';
                      this.style.color = 'white';
                      document.querySelector(`.modal-dislike-btn[data-pmid="${pmid}"]`).style.backgroundColor = '#e0e0e0';
                      document.querySelector(`.modal-dislike-btn[data-pmid="${pmid}"]`).style.color = 'black';
                  } else {
                      this.style.backgroundColor = '#e0e0e0';
                      this.style.color = 'black';
                  }
              } catch (error) {
                  console.error('Error liking paper:', error);
              }
          });
      });

      // Dislike buttons in modal
      document.querySelectorAll('.modal-dislike-btn').forEach(btn => {
          btn.addEventListener('click', async function() {
              const pmid = this.dataset.pmid;
              try {
                  const response = await fetch(`/urea-cycle/ucrh/api/paper/${pmid}/dislike`, { method: 'POST' });
                  const data = await response.json();
                  
                  // Update counts in modal
                  const dislikeCount = this.querySelector('.dislike-count');
                  const likeCount = document.querySelector(`.modal-like-btn[data-pmid="${pmid}"] .like-count`);
                  if (dislikeCount) dislikeCount.textContent = data.dislikes || 0;
                  if (likeCount) likeCount.textContent = data.likes || 0;
                  
                  // Update button styles
                  if (data.dislikes > (parseInt(dislikeCount.textContent) || 0)) {
                      this.style.backgroundColor = '#f44336';
                      this.style.color = 'white';
                      document.querySelector(`.modal-like-btn[data-pmid="${pmid}"]`).style.backgroundColor = '#e0e0e0';
                      document.querySelector(`.modal-like-btn[data-pmid="${pmid}"]`).style.color = 'black';
                  } else {
                      this.style.backgroundColor = '#e0e0e0';
                      this.style.color = 'black';
                  }
              } catch (error) {
                  console.error('Error disliking paper:', error);
              }
          });
      });

      // Comment buttons in modal
      document.querySelectorAll('.modal-comment-btn').forEach(btn => {
          btn.addEventListener('click', function() {
              const pmid = this.dataset.pmid;
              const commentsSection = document.getElementById(`modal-comments-${pmid}`);
              if (commentsSection) {
                  commentsSection.style.display = commentsSection.style.display === 'none' ? 'block' : 'none';
                  if (commentsSection.style.display === 'block') {
                      loadModalComments(pmid);
                  }
              }
          });
      });

      // Submit comment buttons in modal
      document.querySelectorAll('.modal-submit-comment-btn').forEach(btn => {
          btn.addEventListener('click', async function() {
              const pmid = this.dataset.pmid;
              const input = document.querySelector(`.modal-comment-input[data-pmid="${pmid}"]`);
              const commentText = input.value.trim();
              
              if (!commentText) return;
              
              try {
                  const response = await fetch(`/urea-cycle/ucrh/api/paper/${pmid}/comment`, {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ comment: commentText })
                  });
                  const data = await response.json();
                  
                  input.value = '';
                  loadModalComments(pmid);
                  
                  // Update comment count
                  const commentCount = document.querySelector(`.modal-comment-btn[data-pmid="${pmid}"] .comment-count`);
                  if (commentCount) {
                      commentCount.textContent = data.comments ? data.comments.length : 0;
                  }
              } catch (error) {
                  console.error('Error submitting comment:', error);
              }
          });
      });
  }

  async function loadModalComments(pmid) {
      const commentsList = document.getElementById(`modal-comments-list-${pmid}`);
      if (!commentsList) return;
      
      try {
          const response = await fetch(`/urea-cycle/ucrh/api/paper/${pmid}/comments`);
          const data = await response.json();
          
          if (data.comments && data.comments.length > 0) {
              commentsList.innerHTML = data.comments.map(comment => `
                  <div style="margin-bottom: 10px; padding: 8px; background-color: white; border-radius: 4px;">
                      <p style="margin: 0;">${comment.comment_text}</p>
                      <small style="color: #666;">${new Date(comment.created_at).toLocaleDateString()}</small>
                  </div>
              `).join('');
          } else {
              commentsList.innerHTML = '<p style="color: #666; font-style: italic;">No comments yet. Be the first to comment!</p>';
          }
      } catch (error) {
          console.error('Error loading comments:', error);
          commentsList.innerHTML = '<p style="color: #f44336;">Error loading comments.</p>';
      }
  }

  if (newPapersLink && newPapersModal) {
      newPapersLink.addEventListener('click', async function(e) {
          e.preventDefault();
          newPapersModal.style.display = 'block';
          newPapersContent.innerHTML = '<div style="text-align: center; padding: 40px;"><p>Loading new publications...</p></div>';
          
          try {
              const path = window.location.pathname;
              const isCustom = path === '/urea-cycle/ucrh/custom' || path.startsWith('/urea-cycle/ucrh/custom/');
              const since = newPapersLink.getAttribute('data-since');
              
              let url;
              if (isCustom) {
                  const urlParams = new URLSearchParams(window.location.search);
                  const keywords = urlParams.get('keywords') || '';
                  url = `/urea-cycle/ucrh/api/new-papers/custom?keywords=${encodeURIComponent(keywords)}`;
              } else {
                  const gene = getCurrentGene();
                  const extra = getExtraKeywords().join(',');
                  url = `/urea-cycle/ucrh/api/new-papers/${gene}?extra=${encodeURIComponent(extra)}`;
              }
              if (since) {
                  url += '&since=' + encodeURIComponent(since);
              }
              
              const response = await fetch(url);
              const data = await response.json();
              
              if (data.papers && data.papers.length > 0) {
                  newPapersContent.innerHTML = `
                      <ol style="padding-left: 1.5rem;">
                          ${data.papers.map(paper => renderPaperInModal(paper)).join('')}
                      </ol>
                  `;
                  attachModalInteractionListeners();
              } else {
                  newPapersContent.innerHTML = '<div style="text-align: center; padding: 40px;"><p style="font-size: 1.1em; color: #666;">No new publications since your last visit.</p></div>';
              }
          } catch (error) {
              console.error('Error loading new papers:', error);
              newPapersContent.innerHTML = '<div style="text-align: center; padding: 40px;"><p style="color: #f44336;">Error loading new publications. Please try again.</p></div>';
          }
      });

      if (closeModalBtn) {
          closeModalBtn.addEventListener('click', function() {
              newPapersModal.style.display = 'none';
          });
      }

      // Close modal when clicking outside
      newPapersModal.addEventListener('click', function(e) {
          if (e.target === newPapersModal) {
              newPapersModal.style.display = 'none';
          }
      });
  }

});
