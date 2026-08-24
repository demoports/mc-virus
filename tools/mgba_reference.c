/*
 * Headless mc-virus reference recorder for mGBA.
 *
 * This is intentionally a tiny mGBA client rather than a modification to the
 * ROM.  It records the emulator's post-composited 240x160 frames, native GBA
 * audio samples, and the sequencer words recovered from the disassembly.
 *
 * Build against an mGBA source/build tree:
 *   cc -std=c11 -O2 -I "$MGBA_SRC/include" tools/mgba_reference.c \
 *      -L "$MGBA_BUILD" -lmgba -Wl,-rpath,"$MGBA_BUILD" \
 *      -o /tmp/mgba_reference
 *
 * Usage:
 *   /tmp/mgba_reference mc-virus.gba /tmp/mcvirus-reference 12000 60
 */

#ifndef ENABLE_VFS
#define ENABLE_VFS
#endif
#ifndef ENABLE_DIRECTORIES
#define ENABLE_DIRECTORIES
#endif
#ifndef ENABLE_DEBUGGERS
#define ENABLE_DEBUGGERS
#endif

#include <mgba/core/config.h>
#include <mgba/core/core.h>
#include <mgba/core/interface.h>
#include <mgba/core/log.h>
#include <mgba-util/image.h>

#include <errno.h>
#include <inttypes.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>

struct Recorder {
	struct mAVStream stream;
	struct mCore* core;
	FILE* pcm;
	FILE* timeline;
	const char* outDir;
	uint64_t samples;
	unsigned sampleRate;
	unsigned frame;
	unsigned every;
	bool firstState;
};

static void discardLog(struct mLogger* logger, int category, enum mLogLevel level,
		const char* format, va_list args) {
	(void) logger;
	(void) category;
	(void) level;
	(void) format;
	(void) args;
}

static void writeLE16(FILE* f, uint16_t v) {
	fputc((int) (v & 0xff), f);
	fputc((int) (v >> 8), f);
}

static void writeLE32(FILE* f, uint32_t v) {
	writeLE16(f, (uint16_t) v);
	writeLE16(f, (uint16_t) (v >> 16));
}

static void writeWavHeader(FILE* f, unsigned rate, uint32_t frames) {
	rewind(f);
	fwrite("RIFF", 1, 4, f);
	writeLE32(f, 36 + frames * 4);
	fwrite("WAVEfmt ", 1, 8, f);
	writeLE32(f, 16);
	writeLE16(f, 1);
	writeLE16(f, 2);
	writeLE32(f, rate);
	writeLE32(f, rate * 4);
	writeLE16(f, 4);
	writeLE16(f, 16);
	fwrite("data", 1, 4, f);
	writeLE32(f, frames * 4);
}

static void audioRateChanged(struct mAVStream* stream, unsigned rate) {
	struct Recorder* rec = (struct Recorder*) stream;
	rec->sampleRate = rate;
}

static void postAudioFrame(struct mAVStream* stream, int16_t left, int16_t right) {
	struct Recorder* rec = (struct Recorder*) stream;
	writeLE16(rec->pcm, (uint16_t) left);
	writeLE16(rec->pcm, (uint16_t) right);
	++rec->samples;
}

static void savePpm(const struct Recorder* rec, const mColor* pixels, size_t stride) {
	char path[1024];
	snprintf(path, sizeof(path), "%s/frame-%05u.ppm", rec->outDir, rec->frame);
	FILE* f = fopen(path, "wb");
	if (!f) {
		fprintf(stderr, "cannot create %s: %s\n", path, strerror(errno));
		return;
	}
	fprintf(f, "P6\n240 160\n255\n");
	for (unsigned y = 0; y < 160; ++y) {
		for (unsigned x = 0; x < 240; ++x) {
			mColor c = pixels[y * stride + x];
			fputc((int) (c & 0xff), f);
			fputc((int) ((c >> 8) & 0xff), f);
			fputc((int) ((c >> 16) & 0xff), f);
		}
	}
	fclose(f);
}

static uint32_t rd32(struct Recorder* rec, uint32_t address) {
	return rec->core->busRead32(rec->core, address);
}

static void postVideoFrame(struct mAVStream* stream, const mColor* pixels, size_t stride) {
	struct Recorder* rec = (struct Recorder*) stream;
	if (rec->every && rec->frame % rec->every == 0) {
		savePpm(rec, pixels, stride);
	}

	if (!rec->firstState) {
		fputs(",\n", rec->timeline);
	}
	rec->firstState = false;
	fprintf(rec->timeline,
	        "{\"frame\":%u,\"sample\":%" PRIu64
	        ",\"part\":%u,\"partFrame\":%u,\"partCopy\":%u"
	        ",\"cue\":%u,\"cueFrame\":%u,\"shot\":%u,\"subpart\":%u"
	        ",\"subpartFrame\":%u,\"sceneCounter\":%u"
	        ",\"beatPartFrame\":%u,\"randomIndex\":%u}",
	        rec->frame, rec->samples,
	        rd32(rec, 0x03005204), rd32(rec, 0x03005880), rd32(rec, 0x030050d4),
	        rd32(rec, 0x03005210), rd32(rec, 0x03005214), rd32(rec, 0x03005218),
	        rd32(rec, 0x0300521c), rd32(rec, 0x03005284), rd32(rec, 0x03005150),
	        rd32(rec, 0x03005208), rd32(rec, 0x030058ec));
	++rec->frame;
}

int main(int argc, char** argv) {
	if (argc < 3 || argc > 5) {
		fprintf(stderr, "usage: %s ROM OUT_DIR [FRAMES=12000] [CAPTURE_EVERY=60]\n", argv[0]);
		return 2;
	}
	const char* romPath = argv[1];
	const char* outDir = argv[2];
	unsigned frames = argc > 3 ? (unsigned) strtoul(argv[3], NULL, 0) : 12000;
	unsigned every = argc > 4 ? (unsigned) strtoul(argv[4], NULL, 0) : 60;
	struct mLogger quietLogger = { .log = discardLog };
	mLogSetDefaultLogger(&quietLogger);
	if (mkdir(outDir, 0755) && errno != EEXIST) {
		fprintf(stderr, "cannot create %s: %s\n", outDir, strerror(errno));
		return 1;
	}

	char path[1024];
	snprintf(path, sizeof(path), "%s/audio.wav", outDir);
	FILE* pcm = fopen(path, "wb+");
	if (!pcm) {
		fprintf(stderr, "cannot create %s: %s\n", path, strerror(errno));
		return 1;
	}
	/* Leave room for the header; final sizes are patched after emulation. */
	for (unsigned i = 0; i < 44; ++i) {
		fputc(0, pcm);
	}
	snprintf(path, sizeof(path), "%s/timeline.json", outDir);
	FILE* timeline = fopen(path, "wb");
	if (!timeline) {
		fprintf(stderr, "cannot create %s: %s\n", path, strerror(errno));
		fclose(pcm);
		return 1;
	}
	fputs("[\n", timeline);

	struct mCore* core = mCoreFind(romPath);
	if (!core || !core->init(core)) {
		fprintf(stderr, "mGBA could not initialize %s\n", romPath);
		fclose(timeline);
		fclose(pcm);
		return 1;
	}
	mColor* video = calloc(256 * 256, sizeof(*video));
	core->setVideoBuffer(core, video, 256);
	if (!mCoreLoadFile(core, romPath)) {
		fprintf(stderr, "mGBA could not load %s\n", romPath);
		core->deinit(core);
		free(video);
		fclose(timeline);
		fclose(pcm);
		return 1;
	}

	mCoreConfigInit(&core->config, "mcvirus-reference");
	struct mCoreOptions opts = { 0 };
	mCoreConfigMap(&core->config, &opts);
	opts.audioSync = false;
	opts.videoSync = false;
	opts.volume = 0x100;
	opts.mute = false;
	mCoreConfigLoadDefaults(&core->config, &opts);
	mCoreLoadConfig(core);

	struct Recorder rec = { 0 };
	rec.stream.audioRateChanged = audioRateChanged;
	rec.stream.postAudioFrame = postAudioFrame;
	rec.stream.postVideoFrame = postVideoFrame;
	rec.core = core;
	rec.pcm = pcm;
	rec.timeline = timeline;
	rec.outDir = outDir;
	rec.every = every;
	rec.firstState = true;
	core->setAVStream(core, &rec.stream);
	core->reset(core);

	for (unsigned frame = 0; frame < frames; ++frame) {
		core->runFrame(core);
	}

	fputs("\n]\n", timeline);
	fclose(timeline);
	writeWavHeader(pcm, rec.sampleRate, (uint32_t) rec.samples);
	fclose(pcm);
	fprintf(stderr, "recorded %u frames, %" PRIu64 " stereo samples at %u Hz\n",
	        rec.frame, rec.samples, rec.sampleRate);

	core->setAVStream(core, NULL);
	mCoreConfigFreeOpts(&opts);
	mCoreConfigDeinit(&core->config);
	core->deinit(core);
	free(video);
	return 0;
}
