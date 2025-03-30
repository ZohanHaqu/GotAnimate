import fs from "fs";
import httpz from "@octanuary/httpz";
import Database from "../../storage/database.js";
import MovieModel, { Movie } from "../models/movie.js";
import nodezip from "node-zip";

const group = new httpz.Group();

/*
redirects
*/
// go_full (tutorial)
group.route("*", /\/videomaker\/full\/(\w+)\/tutorial$/, (req, res) => {
	const theme = req.matches[1];
	res.redirect(`/go_full?tray=${theme}&tutorial=0`);
});
// video list
group.route("GET", "/dashboard/videos", (req, res) => {
	res.redirect("/videos");
});

/*
thumbs
*/
group.route("*", /\/file\/movie\/thumb\/([^/]+)$/, (req, res) => {
	const id = req.matches[1];

	try {
		const readStream = MovieModel.thumb(id);
		res.setHeader("Content-Type", "image/png");
		readStream.pipe(res); 
	} catch (err) {
		if (err == "404") {
			return res.status(404).end();
		}
		console.log(req.parsedUrl.pathname, "failed. Error:", err);
		res.status(500).end();
	}
});

/*
info
*/
group.route("GET", "/api/movie/get_info", (req, res) => {
	const id = req.query.id;
	if (!id) {
		return res.status(400).json({msg:"Movie ID missing."});
	}

	const movie = Database.get("movies", id)
	if (movie) {
		res.json(movie.data);
	} else {
		res.status(404).json({msg:"Movie not found."});
	}
});

/*
list
*/
// movies
group.route("GET", "/api/movie/list", (req, res) => {
	const type = req.query.type;
	const basePath = req.query.path;
	if (!type) {
		return res.status(400).json({ msg:"Expected type parameter" });
	}
	let movies:Movie[];
	switch (type) {
		case "starter":
			movies = Database.select("assets", { type: "movie" }) as any as Movie[];
			return res.json({ movies });
		case "movie":
		default:
			movies = Database.select("movies");
	}
	movies = movies.filter(m => {
		return basePath ? m.parent_id == basePath : !m.parent_id;
	});
	const folders = Database.select("movie_folders", {
		parent_id: basePath ? basePath : "/",
	});
	let folderPath = [];
	if (basePath) {
		let rootFound = false;
		let currentId = basePath;
		while (!rootFound) {
			const dbRes = Database.get("movie_folders", currentId);
			if (!dbRes) {
				if (currentId == basePath) {
					return res.status(404).json({ msg:"Path does not exist" });
				}
				res.log(`Parent folder with id "${currentId}" not found, returning with empty folder_path...`);
				folderPath = [];
				break;
			}
			const folder = dbRes.data;
			currentId = folder.parent_id;
			if (currentId == "/") {
				rootFound = true;
				currentId = null;
			}
			folderPath.unshift({
				id: folder.id,
				title: folder.title
			});
		}
	}
	res.json({ folder_path:folderPath, folders, movies });
});

/*
rename folder
*/
group.route("GET", "/api/movie/rename_folder", (req, res) => {
	const { new:newName, path } = req.query;
	if (!newName) {
		return res.status(400).json({msg:"Expected newName parameter"});
	}
	if (!path) {
		return res.status(400).json({msg:"Expected path parameter"});
	}

	try {
		MovieModel.renameFolder(path, newName);
		res.json({status:"ok"});
	} catch (e) {
		if (e == "404") {
			return res.status(404).json({status:"error"});
		}
		console.error(req.parsedUrl.pathname, "failed. Error:", e);
		res.status(500).json({status:"error"});
	}
});

/*
move folder
*/
group.route("POST", "/api/movie/move_selection", (req, res) => {
	/** list of movie ids to move */
	const movies:string[]|void = req.body.movies;
	/** list of folder ids to move */
	const movieFolders:string[]|void = req.body.movie_folders;
	/** id of the parent folder to move to */
	const newParentId:string|void = req.body.new_parent_id;

	if ((!movies && !movieFolders) || !newParentId) {
		return res.status(400).json({msg:"Required parameter is missing"});
	}

	try {
		MovieModel.moveToFolder({
			movieIds: movies || [],
			movieFolderIds: movieFolders || []
		}, newParentId);
		res.json({ status:"ok" });
	} catch (e) {
		switch (e) {
			case "t-404":
				return res.status(404).json({ status:"Specified target folder does not exist" });
			case "m-404":
				return res.status(404).json({ status:"A specified movie does not exist" });
			case "f-404":
				return res.status(404).json({ status:"A specified folder does not exist" });
			default: {
				console.error(req.parsedUrl.pathname, "failed. Error:", e);
				res.status(500).json({ status:"error" });
			}
		}
		
	}
});

/*
delete folder
*/
/*
move folder
*/
group.route("GET", "/api/movie/delete_folder", (req, res) => {
	const { path } = req.query;
	if (!path) {
		return res.status(400).json({msg:"Expected path parameter"});
	}

	try {
		MovieModel.deleteFolder(path);
		res.json({status:"ok"});
	} catch (e) {
		if (e == "404") {
			return res.status(404).json({status:"error"});
		}
		console.error(req.parsedUrl.pathname, "failed. Error:", e);
		res.status(500).json({status:"error"});
	}
});

/*
delete
*/
group.route("GET", /\/api\/movie\/delete\/([^/]+)$/, async (req, res) => {
	const id = req.matches[1];
	console.log(`${req.parsedUrl.pathname}: Deleting movie #${id}...`);
	MovieModel.delete(id).then(() => {
		console.log(`${req.parsedUrl.pathname}: Successfully deleted movie #${id}.`);
		res.end();
	}).catch((err) => {
		if (err == "404") {
			return res.status(404).json({ msg: "Movie doesn't exist." });
		}
		console.error(req.parsedUrl.pathname, "failed. Error:", err);
		res.status(500).json({ msg: "Internal server error." });
	});
});

/*
upload
*/
group.route("POST", "/api/movie/upload", (req, res) => {
	const file = req.files.import;
	const isStarter = req.body.is_starter;
	if (typeof file == "undefined") {
		return res.status(400).json({ msg: "No file." });
	}

	const path = file.filepath, buffer = fs.readFileSync(path);
	if (
		file.mimetype !== "application/x-zip-compressed" &&
		file.mimetype !== "application/zip" &&
		!buffer.subarray(0, 4).equals(
			Buffer.from([0x50, 0x4b, 0x03, 0x04])
		)
	) {
		return res.status(400).json({ msg: "Movie is not a zip." });
	}

	MovieModel.upload(buffer, isStarter).then((id) => {
		fs.unlinkSync(path);
		res.json({ id: id });
	}).catch((err) => {
		console.error("Controllers.movie#upload error:", err);
		res.status(500).json({ msg: null });
	});
});

/*
pack
*/
group.route(
	"*",
	/^\/file\/movie\/file\/([^/]+)|\/goapi\/getMovie\/$/,
	(req, res) => {
		const isPost = req.method == "POST";
		const id = req.body.movieId = isPost ?
			req.query.movieId :
			req.matches[1];
		if (typeof id == "undefined") {
			return res.status(400).end("ID not specified.");
		}

		MovieModel.packMovie(id).then((zipped) => {
			if (isPost) {
				zipped = Buffer.concat([Buffer.alloc(1, 0), zipped]);
			}
			res.setHeader("Content-Type", "application/zip");
			res.end(zipped);
		}).catch((err) => {
			if (err == "404") {
				return res.status(404).end("Movie doesn't exist.");
			}
			console.error("Controllers.movie#pack error:", err);
			res.status(500).end("Internal server error.");
		});
	}
);

/*
save
*/
group.route("POST", ["/goapi/saveMovie/", "/goapi/saveTemplate/"], (req, res) => {
	if (!req.body.body_zip) {
		return res.status(400).end("Expected body_zip field");
	}
	const trigAutosave = req.body.is_triggered_by_autosave;
	// make sure we're autosaving an existing movie
	if (trigAutosave && !req.body.movieId) {
		return res.end("0"); // lie
	}
	// check if there's a thumbnail in case this is a manual save
	if (!trigAutosave && !req.body.thumbnail_large) {
		return res.status(400).end("No is_triggered_by_autosave, expected thumbnail_large field");
	}
	
	const body = Buffer.from(req.body.body_zip, "base64");
	let thumb:Buffer | void;
	if (!trigAutosave) {
		thumb = Buffer.from(req.body.thumbnail_large, "base64");
	}
	// zip check
	if (!body.subarray(0, 4).equals(
		Buffer.from([0x50, 0x4b, 0x03, 0x04])
	)) {
		return res.status(400).end("Movie is not a zip.");
	}
	
	console.log(`Controllers.movie#save: Saving movie #${req.body.movieId || "<new movie>"}...`);
	// extract the xml from the BLANK ZIP YOU FUCKERS
	// YOU GOANIMATE HACKS
	// wow 2023 octanuary crash out
	const xmlStream = nodezip.unzip(body)["movie.xml"].toReadStream();
	let buffers = [];
	xmlStream.on("data", (c:Buffer) => buffers.push(c));
	xmlStream.on("end", () => {
		const movieXml = Buffer.concat(buffers);
		const saveAsStarter = req.parsedUrl.pathname == "/goapi/saveTemplate/";
		MovieModel.save(movieXml, thumb, req.body.movieId, saveAsStarter).then((id:string) => {
			console.log(`Controllers.movie#save: Successfully saved movie #${id}.`);
			res.end("0" + id);
		}).catch((err:Error|"404") => {
			if (err == "404") {
				return res.status(404).end("Specified movie doesn't exist.");
			}
			console.error("Controllers.movie#save error:", err);
			res.status(500).end("Internal server error.");
		});
	});
});

export default group;
