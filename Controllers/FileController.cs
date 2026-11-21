using Microsoft.AspNetCore.Mvc;
using System.Text.Json;
using System.Security.Cryptography;

namespace TestProject.Controllers;

[ApiController]
[Route("api")]
public class FilesController : ControllerBase{
    private readonly IWebHostEnvironment environment;

    public FilesController(IWebHostEnvironment environment){
        this.environment = environment;
    }

    // where data will be stored
    private string DataFolder => Path.Combine(environment.ContentRootPath, "AppData");
    private string ListFile => Path.Combine(DataFolder, "items.json");
    private string UploadFolder => Path.Combine(DataFolder, "uploads");

    // reading StoredItem list
    private List<StoredItem> ReadItems(){
        Directory.CreateDirectory(DataFolder);
        if (!System.IO.File.Exists(ListFile))
            return new List<StoredItem>();

        string json = System.IO.File.ReadAllText(ListFile);
        var items = JsonSerializer.Deserialize<List<StoredItem>>(json) ?? new List<StoredItem>();
        bool changed = false;
        var used = new HashSet<string>(items.Where(x => !string.IsNullOrEmpty(x.ShortId)).Select(x => x.ShortId), StringComparer.Ordinal);
        foreach (var folder in items.Where(x => x.IsFolder && string.IsNullOrEmpty(x.ShortId))) {
            folder.ShortId = NewShortId(used);
            changed = true;
        }
        if (changed) SaveItems(items);
        return items;
    }

    // save the list so folders and file details remain after restarting.
    private void SaveItems(List<StoredItem> items) {
        Directory.CreateDirectory(DataFolder);
        string json = JsonSerializer.Serialize(items);
        System.IO.File.WriteAllText(ListFile, json);
    }

    private static string NewShortId(HashSet<string> used) {
        const string alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
        while (true) {
            var bytes = RandomNumberGenerator.GetBytes(8);
            var candidate = new string(bytes.Select(b => alphabet[b & 63]).ToArray());
            if (used.Add(candidate)) return candidate;
        }
    }

    // Resolve the short public URL ID to the existing GUID-backed folder.
    [HttpGet("folders/by-short-id/{shortId}")]
    public IActionResult GetFolderByShortId(string shortId) {
        var folder = ReadItems().FirstOrDefault(x => x.IsFolder && x.ShortId == shortId);
        return folder == null ? NotFound("Folder not found.") : Ok(folder);
    }

    // GET api/items: shows files and folders in current folder
    [HttpGet("items")]
    public IActionResult GetItems([FromQuery] Guid? parentId, [FromQuery] string? search = null){
        var items = ReadItems();
        if (parentId != null && !items.Any(item => item.Id == parentId && item.IsFolder))
            return NotFound("Folder not found."); // nothing matches the parentID

        var contents = items.Where(item => item.ParentId == parentId);
        if (!string.IsNullOrWhiteSpace(search)){
            string term = search.Trim();
            contents = contents.Where(item => item.Name.Contains(term, StringComparison.OrdinalIgnoreCase));
        }
        return Ok(contents.ToList()); 
    }

    // GET api/folders:Shows the same current-folder contents as api/items.
    [HttpGet("folders")]
    public IActionResult GetFolders([FromQuery] Guid? parentId, [FromQuery] string? search = null) {
        return GetItems(parentId, search);
    }

    // GET api/folders/{id}: Gets information about a folder.
    [HttpGet("folders/{id:guid}")]
    public IActionResult GetFolder(Guid id) {
        var folder = ReadItems().FirstOrDefault(item => item.Id == id && item.IsFolder);
        if (folder == null) return NotFound("Folder not found.");
        return Ok(folder);
    }

    // POST api/folders: Creates a folder
    [HttpPost("folders")]
    public IActionResult CreateFolder([FromBody] CreateFolderRequest request) {
        if (string.IsNullOrWhiteSpace(request.Name))
            return BadRequest("Folder name is required.");

        var items = ReadItems();
        if (request.ParentId != null && !items.Any(item => item.Id == request.ParentId && item.IsFolder))
            return BadRequest("Parent folder does not exist.");

        var folder = new StoredItem{
            Id = Guid.NewGuid(),
            ShortId = NewShortId(new HashSet<string>(items.Select(x => x.ShortId), StringComparer.Ordinal)),
            Name = request.Name.Trim(),
            ParentId = request.ParentId,
            IsFolder = true,
            Modified = DateTimeOffset.UtcNow
        };

        items.Add(folder);
        SaveItems(items);
        return Ok(folder);
    }

    // POST api/files: Uploads selected files into current folder
    [HttpPost("files")]
    [RequestSizeLimit(100_000_000)]
    public async Task<IActionResult> Upload([FromForm] List<IFormFile> files, [FromForm] Guid? parentId){
        if (files.Count == 0) return BadRequest("Choose at least one file.");
        if (files.Any(file => file.Length > 50_000_000))
            return BadRequest("Maximum file size is 50 MB.");

        var items = ReadItems();
        if (parentId != null && !items.Any(item => item.Id == parentId && item.IsFolder))
            return BadRequest("Parent folder does not exist.");

        Directory.CreateDirectory(UploadFolder);
        var uploaded = new List<StoredItem>();

        foreach (var file in files){
            string name = Path.GetFileName(file.FileName);
            if (string.IsNullOrWhiteSpace(name)) continue;

            var newItem = new StoredItem
            {
                Id = Guid.NewGuid(),
                Name = name,
                ParentId = parentId,
                IsFolder = false,
                Size = file.Length,
                ContentType = file.ContentType,
                Modified = DateTimeOffset.UtcNow
            };

            string filePath = Path.Combine(UploadFolder, newItem.Id.ToString());
            using (var stream = System.IO.File.Create(filePath))
            {
                await file.CopyToAsync(stream);
            }
            uploaded.Add(newItem);
        }

        // Check again in case the parent folder was removed during upload.
        items = ReadItems();
        if (parentId != null && !items.Any(item => item.Id == parentId && item.IsFolder)){
            foreach (var item in uploaded)
                System.IO.File.Delete(Path.Combine(UploadFolder, item.Id.ToString()));
            return BadRequest("Parent folder no longer exists.");
        }

        items.AddRange(uploaded);
        SaveItems(items);
        return Ok(uploaded);
    }

    // GET api/files/{id}/download: Downloads the selected file.
    [HttpGet("files/{id:guid}/download")]
    public IActionResult Download(Guid id){
        var item = ReadItems().FirstOrDefault(file => file.Id == id && !file.IsFolder);
        if (item == null) return NotFound("File not found.");

        string filePath = Path.Combine(UploadFolder, id.ToString());
        if (!System.IO.File.Exists(filePath)) return NotFound("File not found.");
        return PhysicalFile(filePath, "application/octet-stream", item.Name);
    }

    // DELETE api/folders/{id}: Recursively removes a folder and its descendants.
    [HttpDelete("folders/{id:guid}")]
    public IActionResult DeleteFolder(Guid id){
        var items = ReadItems();
        var folder = items.FirstOrDefault(item => item.Id == id && item.IsFolder);
        if (folder == null) return NotFound("Folder not found.");

        var idsToRemove = new HashSet<Guid> { id };
        // Repeat until all nested descendants have been included.
        bool foundMore;
        do
        {
            foundMore = false;
            foreach (var item in items)
            {
                if (item.ParentId.HasValue && idsToRemove.Contains(item.ParentId.Value))
                    foundMore |= idsToRemove.Add(item.Id);
            }
        } while (foundMore);

        var removed = items.Where(item => idsToRemove.Contains(item.Id)).ToList();
        items.RemoveAll(item => idsToRemove.Contains(item.Id));
        SaveItems(items);
        foreach (var file in removed.Where(item => !item.IsFolder))
        {
            var filePath = Path.Combine(UploadFolder, file.Id.ToString());
            if (System.IO.File.Exists(filePath)) System.IO.File.Delete(filePath);
        }
        return NoContent();
    }

    // DELETE api/files/{id}: Deletes a file and its saved information.
    [HttpDelete("files/{id:guid}")]
    public IActionResult Delete(Guid id){
        var items = ReadItems();
        var item = items.FirstOrDefault(file => file.Id == id && !file.IsFolder);
        if (item == null) return NotFound("File not found.");

        items.Remove(item);
        SaveItems(items);
        string filePath = Path.Combine(UploadFolder, id.ToString());
        if (System.IO.File.Exists(filePath)) System.IO.File.Delete(filePath);
        return NoContent();
    }
}

public class StoredItem{
    public string ShortId { get; set; } = "";
    public Guid Id { get; set; }
    public Guid? ParentId { get; set; }
    public string Name { get; set; } = "";
    public bool IsFolder { get; set; }
    public long Size { get; set; }
    public string ContentType { get; set; } = "";
    public DateTimeOffset Modified { get; set; }
}

public class CreateFolderRequest{
    public string Name { get; set; } = "";
    public Guid? ParentId { get; set; }
}
