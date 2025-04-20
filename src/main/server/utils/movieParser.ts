/*
movie parsing
 if you don't know what's going on here, look at the lvm's code
 ffdec does a great job with that
*/

import AssetModel, { Asset } from "../models/asset";
import type { Char } from "../models/char";
import CharModel from "../models/char";
import database from "../../storage/database";
import fileUtil from "./fileUtil";
import fs from "fs";
import nodezip from "node-zip";
import path from "path";
import { Readable } from "stream";
import { XmlDocument } from "xmldoc";

const source = path.join(__dirname, "../resources/static", process.env.CLIENT_URL);
const store = path.join(__dirname, "../resources/static", process.env.STORE_URL);
const header = process.env.XML_HEADER;

/**
 * returns a font id's corresponding file name
 * @param font font id
 */
function fontId2File(font:string) {
	switch (font) {
		case "Blambot Casual":
			return "FontFileCasual";
		case "BadaBoom BB":
			return "FontFileBoom";
		case "Entrails BB":
			return "FontFileEntrails";
		case "Tokyo Robot Intl BB":
			return "FontFileTokyo";
		case "Accidental Presidency":
			return "FontFileAccidental";
		case "Budmo Jiggler":
			return "FontFileBJiggler";
		case "Budmo Jigglish":
			return "FontFileBJigglish";
		case "Existence Light":
			return "FontFileExistence";
		case "HeartlandRegular":
			return "FontFileHeartland";
		case "Honey Script":
			return "FontFileHoney";
		case "I hate Comic Sans":
			return "FontFileIHate";
		case "loco tv":
			return "FontFileLocotv";
		case "Mail Ray Stuff":
			return "FontFileMailRay";
		case "Mia\'s Scribblings ~":
			return "FontFileMia";
		case "Coming Soon":
			return "FontFileCSoon";
		case "Lilita One":
			return "FontFileLOne";
		case "Telex Regular":
			return "FontFileTelex";
		case "":
		case null:
			return '';
		default:
			return `FontFile${font.replace(/\s/g, '')}`;
	}
}

/**
 * converts a readable stream to a buffer
 */
function stream2Buffer(readStream:Readable): Promise<Buffer> {
	return new Promise((res, rej) => {
		let buffers = [];
		readStream.on("data", (c) => buffers.push(c));
		readStream.on("end", () => res(Buffer.concat(buffers)));
	});
}

export default {
	/**
	 * Parses a movie XML by adding files to a ZIP.
	 * @param xmlBuffer movie xml
	 * @param thumbBuffer thumbnail
	 */
	async pack(xmlBuffer:Buffer, thumbBuffer?:Buffer): Promise<Buffer> {
		if (xmlBuffer.length == 0) throw null;

		const zip = nodezip.create();
		const themes:Record<string, boolean> = { common: true };
		let ugc = `${header}<theme id="ugc" name="ugc">`;
		/** were changes made to the movie xml */
		let changesMade = false;

		/**
		 * why not just merge em together they're all similar anyway
		 * @param file specifies the asset that's being loaded
		 * @param type asset type
		 * @param subtype asset subtype
		 * @param sceneId id of the scene the asset occurs in
		 */
		async function basicParse(file:string, type:string, subtype?:string) {
			const pieces = file.split(".");
			const themeId = pieces[0];
			
			// add the extension to the last key
			const ext = pieces.pop();
			pieces[pieces.length - 1] += "." + ext;
			// add the type to the filename
			pieces.splice(1, 0, type);

			const filename = pieces.join(".");
			let buffer:Buffer;

			// retrieve the asset buffer and if applicable, the ugc info as well
			try {
				if (themeId == "ugc") {
					const id = pieces[2];
					buffer = AssetModel.load(id, true);

					// add asset meta
					const assetMeta = database.get("assets", id);
					if (!assetMeta) {
						throw new Error(`Asset #${id} is in the XML, but it does not exist.`);
					}
					ugc += AssetModel.meta2Xml(assetMeta.data);

					// add video thumbnails
					if (type == "prop" && subtype == "video") {
						pieces[2] = pieces[2].slice(0, -3) + "png";
						const filename = pieces.join(".")
						const buffer = AssetModel.load(pieces[2], true);
						fileUtil.addToZip(zip, filename, buffer);
					}
				} else {
					if (type == "prop" && pieces.indexOf("head") > -1) {
						pieces[1] = "char";
					}	
					const filepath = `${store}/${pieces.join("/")}`;
					buffer = fs.readFileSync(filepath);
				}
			} catch (e) {
				// asset failed to load, we're putting the video on life support
				// (commenting out missing assets so it can still load)

				// add scene and asset id to list of 
				console.error(`WARNING: Asset failed to load! It will be commented out for future playback.`);
				return false;
			}

			fileUtil.addToZip(zip, filename, buffer);	
			themes[themeId] = true;
			return true;
		}
	
		// begin parsing the movie xml
		const film = new XmlDocument(xmlBuffer.toString());
		for (const eI in film.children) {
			const elem = film.children[eI];
	
			switch (elem.name) {
				case "sound": {
					const file = elem.childNamed("sfile")?.val;
					if (!file) continue;
					
					const success = await basicParse(file, elem.name);
					if (!success) {
						film.children[eI].name = "ELEMENT";
						film.children[eI].attr = {};
						changesMade = true;
					}
					break;
				}
	
				case "scene": {
					for (const e2I in elem.children) {
						const elem2 = elem.children[e2I];
	
						let tag = elem2.name;
						// change the tag to the one in the store folder
						if (tag == "effectAsset") tag = "effect";
	
						switch (tag) {
							case "durationSetting":
							case "trans":
								break;
							case "bg":
							case "effect":
							case "prop": {
								const file = elem2.childNamed("file")?.val;
								if (!file) continue;
								
								const success = await basicParse(file, tag, elem2.attr.subtype);
								if (!success) {
									elem.children[e2I].name = "ELEMENT";
									elem.children[e2I].attr = {};
									changesMade = true;
								}
								break;
							}
							
							case "char": {
								let file = elem2.childNamed("action")?.val;
								if (!file) continue;
								const pieces = file.split(".");
								const themeId = pieces[0];
	
								const ext = pieces.pop();
								pieces[pieces.length - 1] += "." + ext;
								pieces.splice(1, 0, elem2.name);
		
								if (themeId == "ugc") {
									// remove the action from the array
									pieces.splice(3, 1);
	
									const id = pieces[2];
									try {
										const charXml = CharModel.charXml(id);
										const filename = pieces.join(".");
	
										ugc += AssetModel.meta2Xml({
											// i can't just select the character data because of stock chars :(
											id: id,
											type: "char",
											themeId: CharModel.getThemeId(charXml)
										} as Char);
										fileUtil.addToZip(zip, filename + ".xml", charXml);
									} catch (e) {
										elem.children[e2I].name = "ELEMENT";
										elem.children[e2I].attr = {};
										changesMade = true;
									}
								} else {
									const filepath = `${store}/${pieces.join("/")}`;
									const filename = pieces.join(".");

									try {
										fileUtil.addToZip(zip, filename, fs.readFileSync(filepath));
									} catch (e) {
										elem.children[e2I].name = "ELEMENT";
										elem.children[e2I].attr = {};
										changesMade = true;
									}
								}
	
								for (const e3I in elem2.children) {
									const elem3 = elem2.children[e3I];
									if (!elem3.children) continue;
	
									// add props and head stuff
									file = elem3.childNamed("file")?.val;
									if (!file) continue;
									const pieces2 = file.split(".");
	
									// headgears and handhelds
									if (elem3.name != "head") {
										const success = await basicParse(file, "prop");
										if (!success) {
											elem2.children[e3I].name = "ELEMENT";
											elem2.children[e3I].attr = {};
											changesMade = true;
										}
									} else { // heads
										// i used to understand this
										// i'll look back on it and explain when i'm in the mood to refactor this
										if (pieces2[0] == "ugc") continue;
										pieces2.pop(), pieces2.splice(1, 0, "char");
										const filepath = `${store}/${pieces2.join("/")}.swf`;
	
										pieces2.splice(1, 1, "prop");
										const filename = `${pieces2.join(".")}.swf`;
										try {	
											fileUtil.addToZip(zip, filename, fs.readFileSync(filepath));
										} catch (e) {
											elem2.children[e3I].name = "ELEMENT";
											elem2.children[e3I].attr = {};
											changesMade = true;
										}
									}
	
									themes[pieces2[0]] = true;
								}
	
								themes[themeId] = true;
								break;
							}
	
							case 'bubbleAsset': {
								const bubble = elem2.childNamed("bubble");
								const text = bubble.childNamed("text");
	
								// arial doesn't need to be added
								if (text.attr.font == "Arial") continue;
	
								const filename = `${fontId2File(text.attr.font)}.swf`;
								const filepath = `${source}/go/font/${filename}`;
								fileUtil.addToZip(zip, filename, fs.readFileSync(filepath));
								break;
							}
						}
					}
					break;
				}
			}
		}
	
		if (themes.family) {
			delete themes.family;
			themes.custom = true;
		}
	
		if (themes.cc2) {
			delete themes.cc2;
			themes.action = true;
		}
	
		const themeKs = Object.keys(themes);
		themeKs.forEach((themeId) => {
			if (themeId == "ugc") return;
			const xmlPath = `${store}/${themeId}/theme.xml`;
			const file = fs.readFileSync(xmlPath);
			fileUtil.addToZip(zip, `${themeId}.xml`, file);
		});
	
		fileUtil.addToZip(zip, "themelist.xml", Buffer.from(
			`${header}<themes>${themeKs.map((t) => `<theme>${t}</theme>`).join("")}</themes>`
		));
		fileUtil.addToZip(zip, "ugc.xml", Buffer.from(ugc + "</theme>"));
		if (thumbBuffer) {
			fileUtil.addToZip(zip, "thumbnail.png", thumbBuffer);
		}
		if (changesMade) {
			xmlBuffer = Buffer.from(film.toString());
		}
		fileUtil.addToZip(zip, "movie.xml", xmlBuffer);
		return await zip.zip();
	},

	/**
	 * @
	 */
	async extractAudioTimes(xmlBuffer:Buffer) {
		const film = new XmlDocument(xmlBuffer.toString());
		let audios = [];

		for (const eI in film.children) {
			const elem = film.children[eI];

			if (elem.name !== "sound") continue;
			audios.push(elem);
		}
		return audios.map((v) => {
			const pieces = v.childNamed("sfile").val.split(".");
			const themeId = pieces[0];
			
			// add the extension to the last key
			const ext = pieces.pop();
			pieces[pieces.length - 1] += "." + ext;
			// add the type to the filename
			pieces.splice(1, 0, "sound");

			let filepath;
			if (themeId == "ugc") {
				filepath = path.join(AssetModel.folder, pieces[pieces.length - 1]);
			} else {
				filepath = path.join(store, pieces.join("/"));
			}

			return {
				filepath: filepath,
				start: +v.childNamed("start").val,
				stop: +v.childNamed("stop").val,
				trimStart: +v.childNamed("trimStart")?.val || 0,
				trimEnd: +v.childNamed("trimEnd")?.val || 0,
				fadeIn: {
					duration: +v.childNamed("fadein").attr.duration,
					vol: +v.childNamed("fadein").attr.vol
				},
				fadeOut: {
					duration: +v.childNamed("fadeout").attr.duration,
					vol: +v.childNamed("fadeout").attr.vol
				}
			}
		});
	},

	/**
	 * unpacks a movie zip returns movie xml
	 * @param body body zip
	 * @returns [moviexml buffer, movie thumb buffer]
	 */
	async unpack(body:Buffer): Promise<[Buffer, Buffer]> {
		const zip = nodezip.unzip(body);
		const ugcStream = zip["ugc.xml"].toReadStream();
		const ugcBuffer = await stream2Buffer(ugcStream);
		const ugc = new XmlDocument(ugcBuffer.toString());

		for (const eI in ugc.children) {
			const elem = ugc.children[eI];

			switch (elem.name) {
				case "background": {
					if (!AssetModel.exists(elem.attr.id)) {
						const readStream = zip[`ugc.bg.${elem.attr.id}`].toReadStream();
						const buffer = await stream2Buffer(readStream);
						AssetModel.save(buffer, elem.attr.id, {
							type: "bg",
							subtype: "0",
							title: elem.attr.name,
							id: "c55fb6c.swf"
						});
					}
					break;
				}

				case "prop": {
					if (!AssetModel.exists(elem.attr.id)) {
						if (elem.attr.subtype == "video") {
							const readStream = zip[`ugc.prop.${elem.attr.id}`].toReadStream();
							const buffer = await stream2Buffer(readStream);
							AssetModel.save(buffer, elem.attr.id, {
								type: "prop",
								subtype: "video",
								title: elem.attr.name,
								width: +elem.attr.width,
								height: +elem.attr.height,
								id: elem.attr.id
							} as Asset);

							const readStream2 = zip[`ugc.prop.${elem.attr.id.slice(0, -4)}.png`].toReadStream();
							const buffer2 = await stream2Buffer(readStream2);
							fs.writeFileSync(path.join(
								__dirname,
								"../../",
								AssetModel.folder,
								elem.attr.id.slice(0, -4) + ".png"
							), buffer2);
						} else {
							const readStream = zip[`ugc.prop.${elem.attr.id}`].toReadStream();
							const buffer = await stream2Buffer(readStream);
							AssetModel.save(buffer, elem.attr.id, {
								type: "prop",
								subtype: "0",
								title: elem.attr.name,
								ptype: elem.attr.wearable == "1" ? "wearable" :
									elem.attr.holdable == "1" ? "holdable" :
									"placeable",
								id: elem.attr.id
							});
						}
					}
					break;
				}

				case "char": {
					if (!CharModel.exists(elem.attr.id)) {
						const readStream = zip[`ugc.char.${elem.attr.id}.xml`].toReadStream();
						const buffer = await stream2Buffer(readStream);
						CharModel.save(buffer, {
							type: "char",
							subtype: "0",
							title: elem.attr.name,
							themeId: CharModel.getThemeId(buffer),
							id: elem.attr.id
						});
					}
					break;
				}

				case "sound": {
					switch (elem.attr.subtype) {
						case "bgmusic":
						case "soundeffect":
						case "voiceover":
						case "tts":
							break;
						default: continue;
					}
					if (!AssetModel.exists(elem.attr.id)) {
						const readStream = zip[`ugc.${elem.name}.${elem.attr.id}`].toReadStream();
						const buffer = await stream2Buffer(readStream);
						AssetModel.save(buffer, elem.attr.id, {
							duration: +elem.attr.duration,
							type: elem.name,
							subtype: elem.attr.subtype,
							title: elem.attr.name,
							id: elem.attr.id
						});
					}
					break;
				}
			}
		}

		const readStream = zip["movie.xml"].toReadStream();
		const buffer = await stream2Buffer(readStream);

		let thumbBuffer = Buffer.from([0x00]);
		if (zip["thumbnail.png"]) {
			const readStream2 = zip["thumbnail.png"].toReadStream();
			thumbBuffer = await stream2Buffer(readStream2);
		}
		return [buffer, thumbBuffer];
	}
};
