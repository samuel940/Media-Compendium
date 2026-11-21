// Everything the rendering will change
const allFiles = document.getElementById('items');
const folderBtn = document.getElementById('folderBtn');
const uploadInput = document.getElementById('uploadInput');
const breadcrumbs = document.getElementById('breadcrumbs');
const status = document.getElementById('status');
const sortSelect = document.getElementById('sortSelect');
const searchInput = document.getElementById('searchInput');
const preview = document.querySelector('dialog');

let currentFolderId = null;
let path = [];              
let currentItems = [];      
let view = 'grid';

function showStatus(message) {
    status.textContent = message;
}

// fetching function to make finding errors easier
async function api(url, options) {
    const response = await fetch(url, options);
    if (!response.ok) {
        throw new Error(await response.text());
    }
    return response;
}

// show file and folder sizes 
function formatSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

// displaying clickable folder names above the file list.
function showBreadcrumbs() {
    breadcrumbs.replaceChildren();
    const folders = [{ id: null, name: 'All files' }, ...path];

    folders.forEach((folder, index) => {
        if (index > 0) breadcrumbs.append(' / ');
        const button = document.createElement('button');
        button.textContent = folder.name;
        button.onclick = function () {
            navigateTo(path.slice(0, index));
        };
        breadcrumbs.append(button);
    });

    const title = path.length ? path[path.length - 1].name : 'All files';
    document.getElementById('viewTitle').textContent = title;
}

// gets everything in current folder to be displayed
async function loadItems() {
    showStatus('Loading...');
    const folderId = currentFolderId;
    let url = '/api/items';
    if (folderId) url += '?parentId=' + folderId;

    try {
        const response = await api(url);
        const items = await response.json();
        if (folderId !== currentFolderId) return;
        currentItems = items;
        showItems();
        showStatus('');
    } catch (error) {
        showStatus(error.message);
    }
}

// display files, folders, counts, and sizes.
function showItems() {
    allFiles.replaceChildren();
    showBreadcrumbs();

    const query = searchInput.value.trim().toLocaleLowerCase();
    const items = currentItems.filter(item => item.name.toLocaleLowerCase().includes(query));
    items.sort((a, b) => {
        if (sortSelect.value === 'date') return new Date(b.modified) - new Date(a.modified) || a.name.localeCompare(b.name);
        if (sortSelect.value === 'size') return b.size - a.size || a.name.localeCompare(b.name);
        return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
    });

    let fileCount = 0;
    let folderCount = 0;
    let totalSize = 0;

    items.forEach(item => {
        if (item.isFolder) {
            folderCount++;
        } else {
            fileCount++;
            totalSize += item.size;
        }

        const card = document.createElement('button');
        card.type = 'button';
        card.className = item.isFolder ? 'folder' : 'file';


        const icon = document.createElement('div');
        icon.className = 'item-symbol';
        icon.textContent = item.isFolder ? '📁' : '📄';

        const name = document.createElement('div');
        name.className = 'filename';
        name.textContent = item.name;

        const details = document.createElement('div');
        details.className = 'file-details';
        details.textContent = item.isFolder ? 'Folder' : formatSize(item.size);

        const deleteButton = document.createElement('button');
        deleteButton.type = 'button';
        deleteButton.className = 'item-delete';
        deleteButton.textContent = 'Delete';
        deleteButton.setAttribute('aria-label', 'Delete ' + item.name);
        deleteButton.onclick = async event => {
            event.stopPropagation();
            await deleteItem(item, deleteButton);
        };

        card.append(icon, name, details);
        // Keep the delete control beside the card, not nested inside a button.
        const wrapper = document.createElement('div');
        wrapper.className = 'item-wrapper';
        wrapper.append(card, deleteButton);
        card.onclick = function () {
            if (item.isFolder) openFolder(item);
            else openFile(item);
        };
        allFiles.append(wrapper);
    });

    document.getElementById('fileCount').textContent = fileCount;
    document.getElementById('folderCount').textContent = folderCount;
    document.getElementById('totalSize').textContent = formatSize(totalSize);
    allFiles.classList.toggle('list', view === 'list');
    if (items.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'empty';
        empty.textContent = query ? 'No matching files or folders.' : 'This folder is empty.';
        allFiles.append(empty);
    }
}

// delete function for each item
async function deleteItem(item, button = null) {
    const kind = item.isFolder ? 'folder' : 'file';
    const message = item.isFolder
        ? `Delete folder "${item.name}"?`
        : `Delete file "${item.name}"?`;
    if (!window.confirm(message)) return false;

    if (button) button.disabled = true;
    try {
        const endpoint = item.isFolder ? '/api/folders/' : '/api/files/';
        await api(endpoint + encodeURIComponent(item.id), { method: 'DELETE' });
        await loadItems();
        return true;
    } catch (error) {
        alert(`Could not delete ${kind}: ${error.message}`);
        return false;
    } finally {
        if (button) button.disabled = false;
    }
}

// show files and folder in current open folder
function folderUrl(folderPath) {
    return '/' + folderPath.map(folder => encodeURIComponent(folder.shortId)).join('/');
}

function navigateTo(nextPath) {
    path = nextPath;
    currentFolderId = path.length ? path[path.length - 1].id : null;
    window.history.pushState(null, '', folderUrl(path));
    loadItems();
}

function openFolder(folder) {
    navigateTo([...path, { id: folder.id, shortId: folder.shortId, name: folder.name }]);
}

// Reconstruct breadcrumbs and the active folder from a pasted URL or browser history.
async function restoreFolderFromUrl() {
    const segments = window.location.pathname.split('/').filter(Boolean);
    const restoredPath = [];
    let parentId = null;

    try {
        for (const segment of segments) {
            const id = decodeURIComponent(segment);
            // Resolve each stable 8-character public ID to its internal GUID.
            if (!/^[A-Za-z0-9_-]{8}$/.test(id)) {
                throw new Error('Invalid folder URL.');
            }
            const response = await api('/api/folders/by-short-id/' + encodeURIComponent(id));
            const folder = await response.json();
            if (folder.parentId?.toLowerCase() !== parentId?.toLowerCase()) {
                throw new Error('This folder does not belong to the URL parent.');
            }
            restoredPath.push({ id: folder.id, shortId: folder.shortId, name: folder.name });
            parentId = folder.id;
        }
        path = restoredPath;
        currentFolderId = parentId;
        await loadItems();
    } catch (error) {
        path = [];
        currentFolderId = null;
        window.history.replaceState(null, '', '/');
        await loadItems();
        showStatus('Could not open folder link: ' + error.message);
    }
}

window.addEventListener('popstate', restoreFolderFromUrl);

// show the download/delete dialog for a file.
function openFile(file) {
    const downloadUrl = '/api/files/' + file.id + '/download';
    if (!preview) {
        window.location.href = downloadUrl;
        return;
    }

    document.getElementById('previewTitle').textContent = file.name;
    document.getElementById('previewInfo').textContent = formatSize(file.size);
    const body = document.getElementById('previewBody');
    body.replaceChildren();
    const message = document.createElement('p');
    message.textContent = 'Download this file to open it.';
    body.append(message);
    document.getElementById('downloadPreview').href = downloadUrl;

    document.getElementById('deletePreview').onclick = async function () {
        const deleted = await deleteItem(file, this);
        if (deleted) preview.close();
    };
    preview.showModal();
}

// Close the file dialog.
document.getElementById('closePreview').onclick = function () {
    preview.close();
};

// creating a folder in current folder
folderBtn.onclick = async function () {
    const name = prompt('Folder name:');
    if (!name || !name.trim()) return;

    const newFolder = { name: name.trim(), parentId: currentFolderId };
    try {
        await api('/api/folders', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(newFolder)
        });
        loadItems();
    } catch (error) {
        alert(error.message);
    }
};

// Upload files from Upload files label.
uploadInput.onchange = async function () {
    if (uploadInput.files.length === 0) return;

    const data = new FormData();
    for (const file of uploadInput.files) {
        data.append('files', file);
    }
    if (currentFolderId) data.append('parentId', currentFolderId);

    showStatus('Uploading...');
    try {
        await api('/api/files', { method: 'POST', body: data });
        await loadItems();
    } catch (error) {
        showStatus(error.message);
        alert(error.message);
    }
    uploadInput.value = '';
};

// filter based on search
searchInput.addEventListener('keydown', function (event) {
    if (event.key === 'Enter') {
        event.preventDefault();
        showItems();
    }
});

// Change the order of the files and folders.
sortSelect.onchange = showItems;



function setView(nextView) {
    view = nextView;
    gridBtn?.classList.toggle('selected', view === 'grid');
    listBtn?.classList.toggle('selected', view === 'list');
    showItems();
}

restoreFolderFromUrl();
