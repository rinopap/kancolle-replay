// File manager: saves whole simulator states (all slots A-G, settings, results) as files that live in
// folders, shown as a tree in a left drawer with the opened files as tabs along the top.
// Storage is IndexedDB (falls back to memory when unavailable); files can be exported/imported as JSON.
COMMON.promiseI18n.then(() => {

const UI_MAIN = COMMON.UI_MAIN;

var FM_UI_KEY = 'sim2_fm_ui';
var FM_DRAWER_W = 300;

var FM_DB = {
	db: null,
	mem: { nodes: {}, data: {} },
	ok: false,
	open: function() {
		return new Promise((resolve) => {
			try {
				let req = indexedDB.open('kcsim_files',1);
				req.onupgradeneeded = () => {
					req.result.createObjectStore('nodes',{ keyPath: 'id' });
					req.result.createObjectStore('data');
				};
				req.onsuccess = () => { this.db = req.result; this.ok = true; resolve(true); };
				req.onerror = () => resolve(false);
				req.onblocked = () => resolve(false);
			} catch(e) { console.error(e); resolve(false); }
		});
	},
	_req: function(store,mode,fn) {
		return new Promise((resolve,reject) => {
			let tx = this.db.transaction(store,mode), os = tx.objectStore(store), r = fn(os);
			tx.oncomplete = () => resolve(r && r.result !== undefined ? r.result : undefined);
			tx.onerror = () => reject(tx.error);
			tx.onabort = () => reject(tx.error);
		});
	},
	getAllNodes: function() {
		if (!this.ok) return Promise.resolve(Object.values(this.mem.nodes).map(n => Object.assign({},n)));
		return this._req('nodes','readonly',os => os.getAll());
	},
	putNode: function(node) {
		let n = JSON.parse(JSON.stringify(node));
		if (!this.ok) { this.mem.nodes[n.id] = n; return Promise.resolve(); }
		return this._req('nodes','readwrite',os => os.put(n));
	},
	getData: function(id) {
		if (!this.ok) return Promise.resolve(this.mem.data[id] ? JSON.parse(this.mem.data[id]) : null);
		return this._req('data','readonly',os => os.get(id)).then(d => d || null);
	},
	putData: function(id,data) {
		if (!this.ok) { this.mem.data[id] = JSON.stringify(data); return Promise.resolve(); }
		return this._req('data','readwrite',os => os.put(data,id));
	},
	deleteNode: function(id) {
		if (!this.ok) { delete this.mem.nodes[id]; delete this.mem.data[id]; return Promise.resolve(); }
		return Promise.all([ this._req('nodes','readwrite',os => os.delete(id)), this._req('data','readwrite',os => os.delete(id)) ]);
	},
};

var FM = Vue.createApp({
	data: () => ({
		ready: false,
		persistent: true,
		nodes: [],
		expanded: {},
		tabs: [],
		activeId: null,
		drawerOpen: false,
		pinned: false,
		search: '',
		selectedId: null,

		ctx: { show: false, x: 0, y: 0, id: null },
		renameId: null,
		renameText: '',
		dragId: null,
		drop: { id: null, pos: null },

		toast: '',
		share: { show: false, url: '', loading: false, error: false, copied: false, name: '' },
		busy: false,
		scratchWarned: false,
	}),
	computed: {
		rows: function() {
			let q = this.search.trim().toLowerCase(), rows = [];
			let keep = null;
			if (q) {
				// matching nodes plus their ancestors
				keep = new Set();
				for (let n of this.nodes) {
					if (n.name.toLowerCase().includes(q)) {
						let c = n;
						while (c && !keep.has(c.id)) { keep.add(c.id); c = this.nodeById(c.parent); }
					}
				}
			}
			let walk = (pid,depth) => {
				for (let n of this.children(pid)) {
					if (keep && !keep.has(n.id)) continue;
					rows.push({ node: n, depth: depth });
					if (n.type == 'folder' && (keep || this.expanded[n.id])) walk(n.id,depth+1);
				}
			};
			walk(null,0);
			return rows;
		},
		hasTabs: function() { return this.tabs.length > 0; },
	},
	methods: {
		t: function(key,args) { return this.$t(key,args || []); },
		nodeById: function(id) { return id == null ? null : this.nodes.find(n => n.id == id) || null; },
		children: function(pid) {
			return this.nodes.filter(n => (n.parent || null) == (pid || null)).sort((a,b) => {
				if (a.type != b.type) return a.type == 'folder' ? -1 : 1;
				return (a.order - b.order) || a.name.localeCompare(b.name);
			});
		},
		isDescendant: function(id,ancestorId) {
			let c = this.nodeById(id);
			while (c) {
				if (c.id == ancestorId) return true;
				c = this.nodeById(c.parent);
			}
			return false;
		},
		newId: function() { return 'n' + Date.now().toString(36) + Math.random().toString(36).slice(2,8); },
		uniqueName: function(parent,base) {
			let names = new Set(this.children(parent).map(n => n.name));
			if (!names.has(base)) return base;
			for (let i=2; ; i++) if (!names.has(base+' '+i)) return base+' '+i;
		},
		showToast: function(msg) {
			this.toast = msg;
			clearTimeout(this._toastTimer);
			this._toastTimer = setTimeout(() => { this.toast = ''; }, 3500);
		},

		// ---- persistence of the UI itself ----
		persistUI: function() {
			try {
				localStorage[FM_UI_KEY] = JSON.stringify({
					expanded: this.expanded, pinned: this.pinned, drawerOpen: this.drawerOpen,
					tabs: this.tabs.map(t => t.id), activeId: this.activeId,
				});
			} catch(e) {}
		},
		applyLayout: function() {
			let open = this.drawerOpen && this.pinned;
			document.body.classList.toggle('fmPinned',open);
			document.body.style.setProperty('--fmw',open ? FM_DRAWER_W+'px' : '0px');
		},

		// ---- tree operations ----
		onclickToggleDrawer: function() {
			this.drawerOpen = !this.drawerOpen;
			if (!this.drawerOpen) this.ctx.show = false;
			this.applyLayout();
			this.persistUI();
		},
		onclickPin: function() {
			this.pinned = !this.pinned;
			this.applyLayout();
			this.persistUI();
		},
		parentForNew: function() {
			let n = this.nodeById(this.selectedId);
			if (!n) n = this.nodeById(this.activeId);
			if (!n) return null;
			return n.type == 'folder' ? n.id : (n.parent || null);
		},
		onclickRow: function(node,e) {
			this.selectedId = node.id;
			this.ctx.show = false;
			if (node.type == 'folder') {
				this.expanded[node.id] = !this.expanded[node.id];
				this.persistUI();
			} else if (e.detail < 2) {
				this.openFile(node.id);
			}
		},
		onclickNewFolder: function(parent) {
			if (parent === undefined) parent = this.parentForNew();
			let node = { id: this.newId(), parent: parent, type: 'folder', name: this.uniqueName(parent,this.t('fm_new_folder')), order: Date.now(), updated: Date.now() };
			this.nodes.push(node);
			FM_DB.putNode(node);
			if (parent) this.expanded[parent] = true;
			this.drawerOpen = true;
			this.selectedId = node.id;
			this.startRename(node.id);
			this.persistUI();
		},
		onclickNewFile: async function(parent) {
			if (parent === undefined) parent = this.parentForNew();
			if (!this.checkScratch()) return;
			let node = { id: this.newId(), parent: parent, type: 'file', name: this.uniqueName(parent,this.t('fm_new_file')), order: Date.now(), updated: Date.now() };
			// a new file starts out as a blank simulator
			if (!(await this.leaveCurrent())) return;
			this.nodes.push(node);
			if (parent) this.expanded[parent] = true;
			this.drawerOpen = true;
			this.selectedId = node.id;
			if (!UI_MAIN.loadFileData(null)) { this.nodes.pop(); this.showToast(this.t('fm_busy')); return; }
			this.tabs.push({ id: node.id, working: null, baseline: '', dirty: false });
			this.activeId = node.id;
			await this.writeCurrentTo(node);
			this.startRename(node.id);
			this.persistUI();
		},
		checkScratch: function() {
			// no file open: whatever is on screen is an unsaved scratch state that opening a file would replace
			if (this.activeId || this.scratchWarned) return true;
			if (!window.confirm(this.t('fm_scratch_warn'))) return false;
			this.scratchWarned = true;
			return true;
		},
		// keeps unsaved edits of the open tab in memory before the screen is taken over by another file
		leaveCurrent: async function() {
			if (!UI_MAIN.canSim) { this.showToast(this.t('fm_busy')); return false; }
			let tab = this.tabs.find(t => t.id == this.activeId);
			if (tab) {
				this.refreshDirty();
				tab.working = tab.dirty ? UI_MAIN.uiToFileData() : null;
			}
			return true;
		},
		openFile: async function(id) {
			let node = this.nodeById(id);
			if (!node || node.type != 'file') return;
			if (id == this.activeId) return;
			if (!this.checkScratch()) return;
			if (!(await this.leaveCurrent())) return;
			let tab = this.tabs.find(t => t.id == id);
			if (!tab) {
				tab = { id: id, working: null, baseline: '', dirty: false };
				this.tabs.push(tab);
			}
			this.busy = true;
			try {
				let data = tab.working || await FM_DB.getData(id);
				if (!UI_MAIN.loadFileData(data)) throw new Error('busy');
				this.activeId = id;
				this.selectedId = id;
				if (!tab.working) {
					tab.dirty = false;
					// compare against the state as the UI normalised it, not the raw file
					setTimeout(() => { if (this.activeId == id) { tab.baseline = UI_MAIN.fileStateStr(); tab.dirty = false; } },500);
				} else {
					tab.dirty = true;
				}
			} catch(e) {
				console.error(e);
				this.tabs = this.tabs.filter(t => t !== tab);
				this.showToast(this.t('fm_open_error'));
			}
			this.busy = false;
			this.persistUI();
		},
		onclickTab: function(id) { this.openFile(id); },
		closeTab: async function(id) {
			let tab = this.tabs.find(t => t.id == id);
			if (!tab) return;
			if (id == this.activeId) this.refreshDirty();
			if (tab.dirty && !window.confirm(this.t('fm_close_dirty',[this.nodeName(id)]))) return;
			let ind = this.tabs.indexOf(tab);
			if (id == this.activeId) {
				let next = this.tabs[ind+1] || this.tabs[ind-1];
				if (next) {
					tab.dirty = false; tab.working = null;
					this.tabs.splice(ind,1);
					this.activeId = null;
					await this.openFile(next.id);
					this.persistUI();
					return;
				}
				this.activeId = null;
			}
			this.tabs.splice(ind,1);
			this.persistUI();
		},
		nodeName: function(id) { let n = this.nodeById(id); return n ? n.name : ''; },
		refreshDirty: function() {
			let tab = this.tabs.find(t => t.id == this.activeId);
			if (!tab || !UI_MAIN.canSave || !UI_MAIN.canSim) return;
			if (!tab.baseline) return; // still settling after load
			tab.dirty = UI_MAIN.fileStateStr() != tab.baseline;
		},

		// ---- save ----
		writeCurrentTo: async function(node) {
			let data = UI_MAIN.uiToFileData();
			await FM_DB.putData(node.id,data);
			node.updated = Date.now();
			await FM_DB.putNode(node);
			let tab = this.tabs.find(t => t.id == node.id);
			if (tab) { tab.baseline = data.stateStr; tab.dirty = false; tab.working = null; }
			return data;
		},
		onclickSave: async function() {
			if (!UI_MAIN.canSim) { this.showToast(this.t('fm_busy')); return; }
			let node = this.nodeById(this.activeId);
			if (!node) return this.onclickSaveAs();
			try {
				await this.writeCurrentTo(node);
				this.showToast(this.t('fm_saved',[node.name]));
			} catch(e) {
				console.error(e);
				this.showToast(this.t('fm_save_error'));
			}
		},
		onclickSaveAs: async function() {
			if (!UI_MAIN.canSim) { this.showToast(this.t('fm_busy')); return; }
			let cur = this.nodeById(this.activeId);
			let parent = cur ? (cur.parent || null) : this.parentForNew();
			let name = window.prompt(this.t('fm_saveas_prompt'),this.uniqueName(parent,cur ? cur.name : this.t('fm_new_file')));
			if (name == null) return;
			name = name.trim();
			if (!name) return;
			let node = { id: this.newId(), parent: parent, type: 'file', name: name, order: Date.now(), updated: Date.now() };
			try {
				this.nodes.push(node);
				await this.writeCurrentTo(node);
				// the tab of the old file (unchanged on disk) is replaced by the new file
				let oldInd = this.tabs.findIndex(t => t.id == this.activeId);
				let tab = { id: node.id, working: null, baseline: UI_MAIN.fileStateStr(), dirty: false };
				if (oldInd >= 0) this.tabs.splice(oldInd,1,tab); else this.tabs.push(tab);
				this.activeId = node.id;
				this.selectedId = node.id;
				this.scratchWarned = true;
				if (parent) this.expanded[parent] = true;
				this.drawerOpen = true;
				this.persistUI();
				this.showToast(this.t('fm_saved',[node.name]));
			} catch(e) {
				console.error(e);
				this.nodes = this.nodes.filter(n => n !== node);
				this.showToast(this.t('fm_save_error'));
			}
		},
		onclickDuplicate: async function(id) {
			let node = this.nodeById(id);
			if (!node) return;
			this.ctx.show = false;
			let copy = async (src,parent,rename) => {
				let n = { id: this.newId(), parent: parent, type: src.type, name: rename ? this.uniqueName(parent,this.t('fm_copy_of',[src.name])) : src.name, order: Date.now(), updated: Date.now() };
				this.nodes.push(n);
				await FM_DB.putNode(n);
				if (src.type == 'file') {
					let d = await FM_DB.getData(src.id);
					if (d) await FM_DB.putData(n.id,d);
				} else {
					for (let c of this.children(src.id)) await copy(c,n.id,false);
				}
				return n;
			};
			try {
				let n = await copy(node,node.parent || null,true);
				this.selectedId = n.id;
				if (node.parent) this.expanded[node.parent] = true;
			} catch(e) { console.error(e); this.showToast(this.t('fm_save_error')); }
		},

		// ---- rename / delete / move ----
		startRename: function(id) {
			let n = this.nodeById(id);
			if (!n) return;
			this.ctx.show = false;
			this.renameId = id;
			this.renameText = n.name;
			this.$nextTick(() => {
				let el = this.$refs['rename'+id];
				if (el) el = Array.isArray(el) ? el[0] : el;
				if (el) { el.focus(); el.select(); }
			});
		},
		commitRename: function() {
			let n = this.nodeById(this.renameId);
			this.renameId = null;
			if (!n) return;
			let name = this.renameText.trim();
			if (!name || name == n.name) return;
			n.name = name;
			n.updated = Date.now();
			FM_DB.putNode(n);
		},
		cancelRename: function() { this.renameId = null; },
		onclickDelete: async function(id) {
			let node = this.nodeById(id);
			if (!node) return;
			this.ctx.show = false;
			let ids = [id];
			let collect = pid => { for (let c of this.nodes.filter(n => n.parent == pid)) { ids.push(c.id); collect(c.id); } };
			collect(id);
			let msg = node.type == 'folder' ? this.t('fm_delete_folder',[node.name,ids.length-1]) : this.t('fm_delete_file',[node.name]);
			if (!window.confirm(msg)) return;
			for (let did of ids) {
				this.tabs = this.tabs.filter(t => t.id != did);
				await FM_DB.deleteNode(did);
			}
			this.nodes = this.nodes.filter(n => !ids.includes(n.id));
			if (ids.includes(this.activeId)) this.activeId = null;
			if (ids.includes(this.selectedId)) this.selectedId = null;
			this.persistUI();
		},
		onclickDeleteTree: function() { if (this.selectedId) this.onclickDelete(this.selectedId); },

		onDragStart: function(node,e) {
			this.dragId = node.id;
			e.dataTransfer.effectAllowed = 'move';
			try { e.dataTransfer.setData('text/plain',node.id); } catch(err) {}
		},
		onDragOver: function(node,e) {
			if (!this.dragId || this.dragId == node.id || this.isDescendant(node.id,this.dragId)) { this.drop = { id: null, pos: null }; return; }
			e.preventDefault();
			let r = e.currentTarget.getBoundingClientRect(), y = (e.clientY-r.top)/r.height;
			let pos = node.type == 'folder' ? (y < 0.25 ? 'before' : y > 0.75 ? 'after' : 'into') : (y < 0.5 ? 'before' : 'after');
			this.drop = { id: node.id, pos: pos };
		},
		onDragOverRoot: function(e) {
			if (!this.dragId) return;
			e.preventDefault();
			this.drop = { id: null, pos: 'root' };
		},
		onDragEnd: function() {
			this.dragId = null;
			this.drop = { id: null, pos: null };
		},
		onDrop: function(node,e) {
			e.preventDefault();
			e.stopPropagation();
			let id = this.dragId, pos = this.drop.pos;
			this.onDragEnd();
			if (!id || !node || id == node.id) return;
			this.moveNode(id,node,pos);
		},
		onDropRoot: function(e) {
			e.preventDefault();
			let id = this.dragId;
			this.onDragEnd();
			if (id) this.moveNode(id,null,'root');
		},
		moveNode: function(id,target,pos) {
			let node = this.nodeById(id);
			if (!node || (target && this.isDescendant(target.id,id))) return;
			let parent, siblings;
			if (pos == 'into') parent = target.id;
			else if (pos == 'root' || !target) parent = null;
			else parent = target.parent || null;
			siblings = this.children(parent).filter(n => n.id != id);
			let at = siblings.length;
			if (pos == 'before') at = siblings.findIndex(n => n.id == target.id);
			else if (pos == 'after') at = siblings.findIndex(n => n.id == target.id)+1;
			node.parent = parent;
			siblings.splice(at,0,node);
			siblings.forEach((n,i) => {
				let o = (i+1)*10;
				if (n.order != o || n.id == id) { n.order = o; FM_DB.putNode(n); }
			});
			if (parent) this.expanded[parent] = true;
			this.persistUI();
		},

		// ---- context menu ----
		onctxRow: function(node,e) {
			e.preventDefault();
			this.selectedId = node.id;
			this.ctx = { show: true, x: Math.min(e.clientX,window.innerWidth-190), y: Math.min(e.clientY,window.innerHeight-280), id: node.id };
		},
		onctxEmpty: function(e) {
			e.preventDefault();
			this.selectedId = null;
			this.ctx = { show: true, x: Math.min(e.clientX,window.innerWidth-190), y: Math.min(e.clientY,window.innerHeight-200), id: null };
		},
		ctxNode: function() { return this.nodeById(this.ctx.id); },
		ctxParent: function() {
			let n = this.ctxNode();
			if (!n) return null;
			return n.type == 'folder' ? n.id : (n.parent || null);
		},

		// ---- export / import ----
		fileDataFor: async function(id) {
			let tab = this.tabs.find(t => t.id == id);
			if (id == this.activeId && UI_MAIN.canSim) return UI_MAIN.uiToFileData();
			if (tab && tab.working) return tab.working;
			return FM_DB.getData(id);
		},
		buildExportTree: async function(node) {
			if (node.type == 'file') return { type: 'file', name: node.name, data: await this.fileDataFor(node.id) };
			let kids = [];
			for (let c of this.children(node.id)) kids.push(await this.buildExportTree(c));
			return { type: 'folder', name: node.name, children: kids };
		},
		download: function(name,obj) {
			let blob = new Blob([JSON.stringify(obj)],{ type: 'application/json' });
			let a = document.createElement('a');
			a.href = URL.createObjectURL(blob);
			a.download = name;
			document.body.appendChild(a);
			a.click();
			setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); },1000);
		},
		onclickExport: async function(id) {
			this.ctx.show = false;
			let node = this.nodeById(id);
			if (!node) return;
			try {
				let tree = await this.buildExportTree(node);
				let safe = node.name.replace(/[\\/:*?"<>|]/g,'_');
				this.download(safe + (node.type == 'folder' ? '.kcsim-folder.json' : '.kcsim.json'),{ kcsimFiles: 1, tree: tree });
			} catch(e) { console.error(e); this.showToast(this.t('fm_export_error')); }
		},
		onclickExportAll: async function() {
			this.ctx.show = false;
			try {
				let kids = [];
				for (let c of this.children(null)) kids.push(await this.buildExportTree(c));
				this.download('kcsim-all.kcsim-folder.json',{ kcsimFiles: 1, tree: { type: 'folder', name: 'all', children: kids, isRoot: true } });
			} catch(e) { console.error(e); this.showToast(this.t('fm_export_error')); }
		},
		onclickImport: function() {
			this.ctx.show = false;
			this._importParent = this.parentForNew();
			this.$refs.importInput.value = '';
			this.$refs.importInput.click();
		},
		onchangeImport: async function(e) {
			let files = Array.from(e.target.files || []);
			let parent = this._importParent === undefined ? null : this._importParent, count = 0;
			let add = async (item,par) => {
				let n = { id: this.newId(), parent: par, type: item.type == 'folder' ? 'folder' : 'file', name: this.uniqueName(par,String(item.name || this.t('fm_new_file'))), order: Date.now()+count, updated: Date.now() };
				count++;
				this.nodes.push(n);
				await FM_DB.putNode(n);
				if (n.type == 'file') await FM_DB.putData(n.id,item.data || null);
				else for (let c of (item.children || [])) await add(c,n.id);
				return n;
			};
			try {
				for (let f of files) {
					let obj = JSON.parse(await f.text());
					if (!obj || !obj.kcsimFiles || !obj.tree) throw new Error('format');
					if (obj.tree.isRoot) for (let c of obj.tree.children) await add(c,parent);
					else await add(obj.tree,parent);
				}
				if (parent) this.expanded[parent] = true;
				this.drawerOpen = true;
				this.persistUI();
				this.showToast(this.t('fm_imported'));
			} catch(err) {
				console.error(err);
				this.showToast(this.t('fm_import_error'));
			}
		},

		// ---- share URL (same format as the simulator's share link) ----
		onclickShare: async function(id) {
			this.ctx.show = false;
			let node = this.nodeById(id);
			if (!node || node.type != 'file') return;
			this.share = { show: true, url: '', loading: true, error: false, copied: false, name: node.name };
			try {
				let data = await this.fileDataFor(id);
				let save = JSON.parse(JSON.stringify(data.save));
				save.simSlotsShare = {
					active: data.active,
					slots: (data.slots || []).map((s,i) => {
						if (!s || !s.save) return null;
						let sv = JSON.parse(JSON.stringify(s.save));
						if (i != 0 && s.enemySync) { delete sv.battles; delete sv.startBranches; delete sv.startRoute; }
						return { save: sv, enemySync: s.enemySync };
					}),
				};
				LZMA.compress(JSON.stringify(save),9,(ab) => {
					try {
						let url = window.location.origin + window.location.pathname.replace(/[^/]*$/,'') + '#backup=' + COMMON.arrayBufferToBase64(ab);
						this.share.url = url;
						this.share.loading = false;
						this.$nextTick(() => { let el = this.$refs.shareInput; if (el) el.select(); });
					} catch(err) { console.error(err); this.share.error = true; this.share.loading = false; }
				});
			} catch(e) {
				console.error(e);
				this.share.error = true;
				this.share.loading = false;
			}
		},
		onclickCopyShare: async function() {
			try {
				await navigator.clipboard.writeText(this.share.url);
				this.share.copied = true;
			} catch(e) {
				let el = this.$refs.shareInput;
				if (el) { el.select(); try { this.share.copied = document.execCommand('copy'); } catch(err) {} }
			}
		},

		// ---- startup ----
		init: async function() {
			this.persistent = await FM_DB.open();
			try { this.nodes = await FM_DB.getAllNodes(); } catch(e) { console.error(e); this.nodes = []; }
			let ui = {};
			try { ui = JSON.parse(localStorage[FM_UI_KEY] || '{}'); } catch(e) {}
			this.expanded = ui.expanded || {};
			this.pinned = !!ui.pinned;
			this.drawerOpen = !!ui.drawerOpen;
			this.tabs = (ui.tabs || []).filter(id => this.nodeById(id)).map(id => ({ id: id, working: null, baseline: '', dirty: false }));
			if (ui.activeId && this.tabs.find(t => t.id == ui.activeId)) {
				this.activeId = ui.activeId;
				// the screen already holds the last working state (restored from localStorage); judge changes against the file
				let tab = this.tabs.find(t => t.id == this.activeId);
				let wait = setInterval(async () => {
					if (!UI_MAIN.canSave || !UI_MAIN.canSim) return;
					clearInterval(wait);
					let d = await FM_DB.getData(tab.id);
					tab.baseline = d && d.stateStr ? d.stateStr : UI_MAIN.fileStateStr();
					this.refreshDirty();
				},300);
			}
			this.applyLayout();
			this.ready = true;
			setInterval(() => this.refreshDirty(),1500);
			document.addEventListener('keydown',(e) => {
				if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() == 's') {
					e.preventDefault();
					this.onclickSave();
				} else if (e.key == 'Escape') {
					this.ctx.show = false;
					this.share.show = false;
				}
			});
			document.addEventListener('click',() => { this.ctx.show = false; });
			window.addEventListener('beforeunload',(e) => {
				this.refreshDirty();
				if (this.tabs.some(t => t.dirty || t.working)) { e.preventDefault(); e.returnValue = ''; }
			});
		},
	},
	mounted: function() {
		this.$i18n.locale = localStorage.sim2_lang || 'en';
		this.init();
		// follow the language switch of the main UI
		this.$watch(() => (COMMON.UI_MAIN && COMMON.UI_MAIN.$i18n) ? COMMON.UI_MAIN.$i18n.locale : null,(loc) => { if (loc) this.$i18n.locale = loc; });
	},
}).use(COMMON.i18n).mount('#divFiles');

COMMON.UI_FILES = FM;

});
