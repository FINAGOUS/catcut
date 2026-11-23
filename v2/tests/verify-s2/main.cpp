// CatCut v2 — S2 self-test (verify-s2).
//
// Usage: verify-s2 <probe-dir> <output-dir>
//   probe-dir : test_8k.mp4, test_4k.mp4 (generated in the workflow
//               by the bundled ffmpeg.exe, see v2-build.yml — same
//               probe media as verify-s1, no new generation)
//   output-dir: receives the timeline render PNGs.
//
// Checks (exit 0 = all passed):
//   1. model: ripple insert / ripple delete close up, no gaps
//   2. model: split (incl. keyframe split) and ripple/roll trims
//   3. model: connected clips follow the primary storyline when it
//      moves or is trimmed, and freeze when disconnected (escape
//      hatch); anchor loss on anchor deletion detaches, never deletes
//   4. model: secondary storylines move as one unit
//   5. model: roles -> lanes, per-role stem export hook
//   6. transitions: duration default/clamp, xfade names (5 demo +
//      8-way extension port), filter fragments, window/progress
//   7. keyframes: linear / Bezier / hold interpolation
//   8. evaluator: clip + source time per t, transition midpoint gives
//      two layers at progress 0.5, keyframed opacity, disabled clips
//      vanish, audio layers carry role + gain
//   9. JSON round-trip of a timeline (clips, connected clips,
//      transitions, keyframes)
//  10. render: 3-clip + 1-transition timeline rendered offscreen
//      through the same evaluator + TimelineFrameRenderer the preview
//      uses — first frame and mid-transition frame to PNG, correct
//      size, non-black, and different from each other.
//
// Machine-readable lines for the run log:
//   TRANSITION_XFADE_DISSOLVE=fade  RENDER_DECODE_PATH=<...>

#include <QCoreApplication>
#include <QDir>
#include <QFileInfo>
#include <QGuiApplication>
#include <QImage>
#include <QTextStream>

#include <cmath>
#include <iostream>

#include "core/Keyframes.h"
#include "core/TimelineEvaluator.h"
#include "core/TimelineFrameRenderer.h"
#include "core/TimelineModel.h"
#include "core/Transitions.h"
#include "media/Decoder.h"
#include "media/PreviewRenderer.h"

namespace {

int g_failures = 0;

void check(bool ok, const QString& name, const QString& detail = QString())
{
    QTextStream out(stdout);
    if (ok) {
        out << "[PASS] " << name;
    } else {
        out << "[FAIL] " << name;
        ++g_failures;
    }
    if (!detail.isEmpty())
        out << " — " << detail;
    out << "\n";
    out.flush();
}

bool nearValue(double actual, double expected, double tolerance)
{
    return std::fabs(actual - expected) <= tolerance;
}

catcut::Clip makeClip(const QString& name, const QString& mediaPath,
                      double sourceIn, double sourceOut,
                      catcut::ClipKind kind = catcut::ClipKind::Video,
                      const QString& role = catcut::RoleNames::kDialogue)
{
    catcut::Clip clip;
    clip.name = name;
    clip.mediaPath = mediaPath;
    clip.kind = kind;
    clip.role = role;
    clip.sourceIn = sourceIn;
    clip.sourceOut = sourceOut;
    return clip;
}

catcut::Clip makeTitle(const QString& text, double duration)
{
    catcut::Clip clip;
    clip.name = text;
    clip.text = text;
    clip.kind = catcut::ClipKind::Title;
    clip.role = catcut::RoleNames::kTitle;
    clip.sourceIn = 0.0;
    clip.sourceOut = duration;
    return clip;
}

// Fresh model: primary A(2s) B(2s) C(2s), ids returned.
struct ThreeClipModel {
    catcut::TimelineModel model;
    QString a, b, c;
};

ThreeClipModel freshThree()
{
    ThreeClipModel m;
    m.model.appendPrimaryClip(makeClip(QStringLiteral("A"), QString(), 0.0, 2.0));
    m.model.appendPrimaryClip(makeClip(QStringLiteral("B"), QString(), 0.0, 2.0));
    m.model.appendPrimaryClip(makeClip(QStringLiteral("C"), QString(), 0.0, 2.0));
    m.a = m.model.primaryClips()[0].id;
    m.b = m.model.primaryClips()[1].id;
    m.c = m.model.primaryClips()[2].id;
    return m;
}

} // namespace

int main(int argc, char* argv[])
{
    QGuiApplication app(argc, argv);

    QTextStream out(stdout);
    out << "verify-s2: CatCut v2 S2 timeline self-test\n";
    out << "Qt: " << qVersion() << "\n";
    out.flush();

    if (argc < 3) {
        out << "usage: verify-s2 <probe-dir> <output-dir>\n";
        return 2;
    }
    const QDir probeDir(QString::fromLocal8Bit(argv[1]));
    const QDir outDir(QString::fromLocal8Bit(argv[2]));
    if (!outDir.exists())
        QDir().mkpath(outDir.absolutePath());
    const QString file8k = probeDir.filePath(QStringLiteral("test_8k.mp4"));
    const QString file4k = probeDir.filePath(QStringLiteral("test_4k.mp4"));

    // ------------------------------------------------- 1. ripple insert/delete
    {
        ThreeClipModel m = freshThree();
        const QString x = m.model.insertPrimaryClip(makeClip(QStringLiteral("X"), QString(), 0.0, 1.0), 2.0);
        check(!x.isEmpty(), QStringLiteral("ripple insert returns an id"));
        check(nearValue(m.model.totalDuration(), 7.0, 1e-9), QStringLiteral("ripple insert total is 7s"),
              QString::number(m.model.totalDuration()));
        const catcut::Clip* b = m.model.findClip(m.b);
        const catcut::Clip* c = m.model.findClip(m.c);
        check(b && nearValue(b->timelineStart, 3.0, 1e-9), QStringLiteral("ripple insert shifts B to 3s"),
              b ? QString::number(b->timelineStart) : QStringLiteral("missing"));
        check(c && nearValue(c->timelineStart, 5.0, 1e-9), QStringLiteral("ripple insert shifts C to 5s"),
              c ? QString::number(c->timelineStart) : QStringLiteral("missing"));
        check(m.model.removePrimaryClip(m.b), QStringLiteral("ripple delete B"));
        c = m.model.findClip(m.c);
        check(c && nearValue(c->timelineStart, 3.0, 1e-9), QStringLiteral("ripple delete closes up C to 3s"),
              c ? QString::number(c->timelineStart) : QStringLiteral("missing"));
        check(nearValue(m.model.totalDuration(), 5.0, 1e-9), QStringLiteral("ripple delete total is 5s"));
    }

    // ------------------------------------------------- 2. split + trims
    {
        ThreeClipModel m = freshThree();
        // Keyframes on A: opacity 1 at 0.5s, 0 at 1.5s.
        catcut::Clip* a = m.model.findClip(m.a);
        catcut::Keyframe k1;
        k1.time = 0.5; k1.value = 1.0;
        catcut::Keyframe k2;
        k2.time = 1.5; k2.value = 0.0;
        a->keyframes.opacity.addKeyframe(k1);
        a->keyframes.opacity.addKeyframe(k2);
        const QString rightId = m.model.splitPrimaryAt(1.0);
        check(!rightId.isEmpty(), QStringLiteral("split at 1s"));
        check(m.model.primaryClips().size() == 4, QStringLiteral("split makes 4 primary clips"),
              QString::number(m.model.primaryClips().size()));
        const catcut::Clip* right = m.model.findClip(rightId);
        check(right && nearValue(right->sourceIn, 1.0, 1e-9)
                  && nearValue(right->duration(), 1.0, 1e-9),
              QStringLiteral("split right clip is source 1-2s"));
        check(right && right->keyframes.opacity.count() == 1
                  && nearValue(right->keyframes.opacity.keyframes().first().time, 0.5, 1e-9),
              QStringLiteral("split moves later keyframe to right clip, retimed to 0.5s"));
        check(nearValue(m.model.totalDuration(), 6.0, 1e-9), QStringLiteral("split keeps total 6s"));

        ThreeClipModel t = freshThree();
        check(t.model.rollTrim(0, 0.5), QStringLiteral("roll trim +0.5s"));
        check(nearValue(t.model.findClip(t.a)->duration(), 2.5, 1e-9)
                  && nearValue(t.model.findClip(t.b)->duration(), 1.5, 1e-9)
                  && nearValue(t.model.findClip(t.b)->timelineStart, 2.5, 1e-9)
                  && nearValue(t.model.totalDuration(), 6.0, 1e-9),
              QStringLiteral("roll trim grows A, shrinks B, total unchanged"));
        check(t.model.rippleTrimEnd(t.a, 1.0), QStringLiteral("ripple trim end +1s"));
        check(nearValue(t.model.findClip(t.b)->timelineStart, 3.5, 1e-9)
                  && nearValue(t.model.totalDuration(), 7.0, 1e-9),
              QStringLiteral("ripple trim end shifts B/C right, total 7s"));
        check(!t.model.rollTrim(0, 5.0), QStringLiteral("roll trim refusing to shrink B below 0.1s"));
    }

    // --------------------------------------- 3. connected clips follow / freeze
    {
        catcut::TimelineModel model;
        model.appendPrimaryClip(makeClip(QStringLiteral("A"), QString(), 0.0, 2.0));
        model.appendPrimaryClip(makeClip(QStringLiteral("B"), QString(), 0.0, 2.0));
        const QString bId = model.primaryClips()[1].id;
        const QString mId = model.addConnectedClip(
            makeClip(QStringLiteral("M"), QString(), 0.0, 1.0,
                     catcut::ClipKind::Video, catcut::RoleNames::kMusic),
            bId, 0.5, 0.0);
        check(!mId.isEmpty(), QStringLiteral("connected clip anchors to B"));
        const catcut::Clip* mClip = model.findClip(mId);
        check(mClip && nearValue(mClip->timelineStart, 2.5, 1e-9),
              QStringLiteral("connected clip starts at anchor 2.5s"),
              mClip ? QString::number(mClip->timelineStart) : QStringLiteral("missing"));
        model.insertPrimaryClip(makeClip(QStringLiteral("X"), QString(), 0.0, 1.0), 0.0);
        mClip = model.findClip(mId);
        check(mClip && nearValue(mClip->timelineStart, 3.5, 1e-9),
              QStringLiteral("connected clip follows ripple insert (+1s)"),
              mClip ? QString::number(mClip->timelineStart) : QStringLiteral("missing"));
        const QString aId = model.primaryClips()[0].id; // X is now first; A is index 1
        Q_UNUSED(aId);
        model.rippleTrimEnd(model.primaryClips()[1].id, 1.0); // trim A +1s
        mClip = model.findClip(mId);
        check(mClip && nearValue(mClip->timelineStart, 4.5, 1e-9),
              QStringLiteral("connected clip follows ripple trim (+1s)"),
              mClip ? QString::number(mClip->timelineStart) : QStringLiteral("missing"));
        // Disconnect escape hatch: freeze, then move the primary again.
        check(model.disconnectClip(mId), QStringLiteral("disconnect succeeds"));
        mClip = model.findClip(mId);
        check(mClip && mClip->detached && !mClip->connected,
              QStringLiteral("disconnected clip is detached, not connected"));
        const double frozenStart = mClip->timelineStart;
        model.insertPrimaryClip(makeClip(QStringLiteral("Y"), QString(), 0.0, 1.0), 0.0);
        mClip = model.findClip(mId);
        check(mClip && nearValue(mClip->timelineStart, frozenStart, 1e-9),
              QStringLiteral("disconnected clip stays put after primary moves"),
              mClip ? QString::number(mClip->timelineStart) : QStringLiteral("missing"));
        // Anchor loss: deleting the anchor detaches (never deletes) the clip.
        catcut::TimelineModel model2;
        model2.appendPrimaryClip(makeClip(QStringLiteral("A"), QString(), 0.0, 2.0));
        model2.appendPrimaryClip(makeClip(QStringLiteral("B"), QString(), 0.0, 2.0));
        const QString anchorId = model2.primaryClips()[0].id;
        const QString cId = model2.addConnectedClip(
            makeClip(QStringLiteral("M"), QString(), 0.0, 1.0), anchorId, 0.5, 0.0);
        const double beforeStart = model2.findClip(cId)->timelineStart;
        model2.removePrimaryClip(anchorId);
        const catcut::Clip* cClip = model2.findClip(cId);
        check(cClip && cClip->detached && nearValue(cClip->timelineStart, beforeStart, 1e-9),
              QStringLiteral("anchor deletion detaches connected clip, keeps its position"));
    }

    // --------------------------------------------- 4. secondary storylines
    {
        catcut::TimelineModel model;
        model.appendPrimaryClip(makeClip(QStringLiteral("A"), QString(), 0.0, 2.0));
        model.appendPrimaryClip(makeClip(QStringLiteral("B"), QString(), 0.0, 2.0));
        const QString aId = model.primaryClips()[0].id;
        const QString bId = model.primaryClips()[1].id;
        const QString m1 = model.addConnectedClip(makeClip(QStringLiteral("M1"), QString(), 0.0, 1.0),
                                                  aId, 0.5, 0.0);
        const QString m2 = model.addConnectedClip(makeClip(QStringLiteral("M2"), QString(), 0.0, 1.0),
                                                  bId, 0.5, 0.0);
        const QString storyId = model.createStoryline(QStringLiteral("B-roll 组"), { m1, m2 });
        check(!storyId.isEmpty(), QStringLiteral("secondary storyline created"));
        check(model.moveStoryline(storyId, 1.0), QStringLiteral("storyline moves as a unit"));
        check(nearValue(model.findClip(m1)->timelineStart, 1.5, 1e-9)
                  && nearValue(model.findClip(m2)->timelineStart, 3.5, 1e-9),
              QStringLiteral("both storyline members shifted +1s"));
        check(model.storylineClips(storyId).size() == 2, QStringLiteral("storyline holds 2 clips"));
    }

    // ------------------------------------------------------- 5. roles / lanes
    {
        catcut::TimelineModel model;
        model.appendPrimaryClip(makeClip(QStringLiteral("A"), QString(), 0.0, 2.0));
        const QString aId = model.primaryClips()[0].id;
        const QString musicVideo = model.addConnectedClip(
            makeClip(QStringLiteral("MV"), QString(), 0.0, 1.0, catcut::ClipKind::Video,
                     catcut::RoleNames::kMusic), aId, 0.0, 0.0);
        const QString musicAudio = model.addConnectedClip(
            makeClip(QStringLiteral("MA"), QString(), 0.0, 1.0, catcut::ClipKind::Audio,
                     catcut::RoleNames::kMusic), aId, 0.0, 0.0);
        const QString sfxAudio = model.addConnectedClip(
            makeClip(QStringLiteral("SFX"), QString(), 0.0, 1.0, catcut::ClipKind::Audio,
                     catcut::RoleNames::kSfx), aId, 0.0, 0.0);
        const QString title = model.addConnectedClip(
            makeTitle(QStringLiteral("标题"), 2.0), aId, 0.0, 0.0);
        const QList<catcut::TimelineLane> lanes = model.computeLanes();
        check(lanes.size() == 5, QStringLiteral("lanes: primary + 2 video roles + 2 audio roles"),
              QString::number(lanes.size()));
        check(model.laneIndexOf(musicVideo) != model.laneIndexOf(musicAudio)
                  && model.laneIndexOf(musicAudio) != model.laneIndexOf(sfxAudio)
                  && model.laneIndexOf(title) != model.laneIndexOf(musicVideo),
              QStringLiteral("different roles land on different lanes"));
        check(model.laneIndexOf(aId) == 0, QStringLiteral("primary clip is lane 0"));
        const QMap<QString, QList<QString>> stems = model.stemsByRole();
        check(stems.contains(catcut::RoleNames::kMusic)
                  && stems[catcut::RoleNames::kMusic].size() == 2,
              QStringLiteral("stems: music role has 2 clips"));
        check(stems.contains(catcut::RoleNames::kSfx)
                  && stems[catcut::RoleNames::kSfx].size() == 1,
              QStringLiteral("stems: sfx role has 1 clip"));
        check(!stems.contains(catcut::RoleNames::kTitle),
              QStringLiteral("stems: title clips have no audio stem"));
        const int customIndex = model.roleRegistry().addCustomRole(QStringLiteral("旁白"));
        check(customIndex >= 4, QStringLiteral("custom role registers after built-ins"),
              QString::number(customIndex));
    }

    // ------------------------------------------------------- 6. transitions
    {
        catcut::Transition t;
        check(nearValue(t.duration, 0.5, 1e-9), QStringLiteral("transition default duration 0.5s"));
        t.setDuration(0.05);
        check(nearValue(t.duration, 0.1, 1e-9), QStringLiteral("transition duration clamps to 0.1s min"));
        t.setDuration(9.0);
        check(nearValue(t.duration, 5.0, 1e-9), QStringLiteral("transition duration clamps to 5s max"));
        check(catcut::xfadeName(catcut::TransitionType::Dissolve) == QStringLiteral("fade"),
              QStringLiteral("xfade: dissolve -> fade"));
        check(catcut::xfadeName(catcut::TransitionType::FlashWhite) == QStringLiteral("fadewhite"),
              QStringLiteral("xfade: flash white -> fadewhite"));
        check(catcut::xfadeName(catcut::TransitionType::FlashBlack) == QStringLiteral("fadeblack"),
              QStringLiteral("xfade: flash black -> fadeblack"));
        check(catcut::xfadeName(catcut::TransitionType::Wipe) == QStringLiteral("wipeleft"),
              QStringLiteral("xfade: wipe -> wipeleft"));
        check(catcut::xfadeName(catcut::TransitionType::Slide) == QStringLiteral("slideleft"),
              QStringLiteral("xfade: slide -> slideleft"));
        check(catcut::supportedXfadeNames().size() == 8,
              QStringLiteral("8-way xfade extension port"));
        out << "TRANSITION_XFADE_DISSOLVE=" << catcut::xfadeName(catcut::TransitionType::Dissolve) << "\n";
        out.flush();
        catcut::Transition dissolve;
        const QString filter = catcut::buildXfadeFilter(dissolve, 1.75);
        check(filter.contains(QStringLiteral("xfade=transition=fade"))
                  && filter.contains(QStringLiteral("duration=0.500"))
                  && filter.contains(QStringLiteral("offset=1.750")),
              QStringLiteral("xfade filter fragment"), filter);
        check(catcut::buildAcrossfadeFilter(dissolve).contains(QStringLiteral("acrossfade=d=0.500")),
              QStringLiteral("acrossfade filter fragment"));

        ThreeClipModel m = freshThree();
        check(!m.model.setTransition(m.c, catcut::Transition()),
              QStringLiteral("no transition after the last clip"));
        check(m.model.setTransition(m.a, catcut::Transition()),
              QStringLiteral("transition set on A|B boundary"));
        catcut::Transition found;
        double progress = -1.0;
        QString leftId, rightId;
        check(!m.model.transitionAt(1.0, found, progress, leftId, rightId),
              QStringLiteral("no transition window at 1.0s"));
        check(m.model.transitionAt(2.0, found, progress, leftId, rightId)
                  && nearValue(progress, 0.5, 1e-9),
              QStringLiteral("transition midpoint progress is 0.5"),
              QString::number(progress));
        check(m.model.transitionAt(1.75, found, progress, leftId, rightId)
                  && nearValue(progress, 0.0, 1e-9),
              QStringLiteral("transition window starts at 1.75s"));
        check(m.model.transitionAt(2.25, found, progress, leftId, rightId)
                  && nearValue(progress, 1.0, 1e-9),
              QStringLiteral("transition window ends at 2.25s"));
    }

    // ------------------------------------------------------- 7. keyframes
    {
        catcut::KeyframeTrack track(0.0);
        check(nearValue(track.valueAt(3.0), 0.0, 1e-9), QStringLiteral("empty track returns default"));
        catcut::Keyframe k0, k1;
        k0.time = 0.0; k0.value = 0.0;
        k1.time = 2.0; k1.value = 10.0;
        track.addKeyframe(k0);
        track.addKeyframe(k1);
        check(nearValue(track.valueAt(1.0), 5.0, 1e-9), QStringLiteral("linear interpolation at midpoint"));
        check(nearValue(track.valueAt(-1.0), 0.0, 1e-9), QStringLiteral("before first keyframe clamps"));
        check(nearValue(track.valueAt(5.0), 10.0, 1e-9), QStringLiteral("after last keyframe clamps"));

        catcut::KeyframeTrack bezier(0.0);
        catcut::Keyframe b0, b1;
        b0.time = 0.0; b0.value = 0.0;
        b0.interpolation = catcut::KeyframeInterpolation::Bezier;
        b0.outDx = 1.0; b0.outDy = 10.0; // steep start: value rises fast
        b1.time = 2.0; b1.value = 10.0;
        b1.interpolation = catcut::KeyframeInterpolation::Bezier;
        b1.inDx = -1.0; b1.inDy = 0.0;
        bezier.addKeyframe(b0);
        bezier.addKeyframe(b1);
        const double midBezier = bezier.valueAt(1.0);
        check(midBezier > 5.0 && midBezier < 10.0,
              QStringLiteral("bezier interpolation bends above linear"),
              QString::number(midBezier, 'f', 3));
        check(nearValue(bezier.valueAt(0.0), 0.0, 1e-9)
                  && nearValue(bezier.valueAt(2.0), 10.0, 1e-9),
              QStringLiteral("bezier passes through its keyframes"));

        catcut::KeyframeTrack hold(0.0);
        catcut::Keyframe h0, h1;
        h0.time = 0.0; h0.value = 3.0; h0.interpolation = catcut::KeyframeInterpolation::Hold;
        h1.time = 2.0; h1.value = 9.0;
        hold.addKeyframe(h0);
        hold.addKeyframe(h1);
        check(nearValue(hold.valueAt(1.9), 3.0, 1e-9), QStringLiteral("hold keeps value until next keyframe"));
        check(nearValue(hold.valueAt(2.0), 9.0, 1e-9), QStringLiteral("hold jumps at the next keyframe"));
    }

    // ------------------------------------------------------- 8. evaluator
    catcut::TimelineModel evalModel;
    {
        evalModel.appendPrimaryClip(makeClip(QStringLiteral("A"), file4k, 0.0, 2.0));
        evalModel.appendPrimaryClip(makeClip(QStringLiteral("B"), file8k, 0.0, 2.0));
        evalModel.appendPrimaryClip(makeClip(QStringLiteral("C"), file4k, 1.0, 3.0));
        const QString aId = evalModel.primaryClips()[0].id;
        catcut::Transition dissolve;
        evalModel.setTransition(aId, dissolve);
        catcut::Keyframe o0, o1;
        o0.time = 0.0; o0.value = 1.0;
        o1.time = 2.0; o1.value = 0.5;
        evalModel.findClip(aId)->keyframes.opacity.addKeyframe(o0);
        evalModel.findClip(aId)->keyframes.opacity.addKeyframe(o1);
    }
    {
        catcut::TimelineEvaluator evaluator(&evalModel, QSize(960, 540));
        const catcut::FrameScene s05 = evaluator.evaluate(0.5);
        check(s05.videoLayers.size() == 1, QStringLiteral("evaluator: 1 layer at 0.5s"),
              QString::number(s05.videoLayers.size()));
        check(!s05.videoLayers.isEmpty()
                  && nearValue(s05.videoLayers[0].sourceTime, 0.5, 1e-9),
              QStringLiteral("evaluator: source time 0.5s at 0.5s"));
        check(!s05.videoLayers.isEmpty()
                  && nearValue(s05.videoLayers[0].geometry.opacity, 0.875, 1e-9),
              QStringLiteral("evaluator: keyframed opacity 0.875 at 0.5s"));
        check(s05.audioLayers.size() == 1
                  && s05.audioLayers[0].role == catcut::RoleNames::kDialogue
                  && nearValue(s05.audioLayers[0].gain, 1.0, 1e-9),
              QStringLiteral("evaluator: audio layer carries role + gain 1"));
        const catcut::FrameScene s20 = evaluator.evaluate(2.0);
        check(s20.hasTransition && nearValue(s20.transitionProgress, 0.5, 1e-9),
              QStringLiteral("evaluator: transition active at 2.0s, progress 0.5"));
        check(s20.videoLayers.size() == 2, QStringLiteral("evaluator: 2 layers at transition midpoint"),
              QString::number(s20.videoLayers.size()));
        if (s20.videoLayers.size() == 2) {
            check(s20.videoLayers[0].isTransitionOutgoing
                      && s20.videoLayers[1].isTransitionIncoming,
                  QStringLiteral("evaluator: outgoing below incoming"));
            check(nearValue(s20.videoLayers[0].sourceTime, 2.0, 1e-9)
                      && nearValue(s20.videoLayers[1].sourceTime, 0.0, 1e-9),
                  QStringLiteral("evaluator: transition source times 2.0s / 0.0s"));
        }
        const catcut::FrameScene s50 = evaluator.evaluate(5.0);
        check(s50.videoLayers.size() == 1
                  && nearValue(s50.videoLayers[0].sourceTime, 2.0, 1e-9),
              QStringLiteral("evaluator: clip C source time 2.0s at 5.0s"));
        // Disabled clip vanishes.
        catcut::TimelineModel disabledModel;
        disabledModel.appendPrimaryClip(makeClip(QStringLiteral("A"), file4k, 0.0, 2.0));
        disabledModel.findClip(disabledModel.primaryClips()[0].id)->enabled = false;
        catcut::TimelineEvaluator disabledEval(&disabledModel, QSize(960, 540));
        check(disabledEval.evaluate(1.0).videoLayers.isEmpty(),
              QStringLiteral("evaluator: disabled clip produces no layer"));
    }

    // ------------------------------------------------------- 9. JSON round-trip
    {
        const QJsonObject json = evalModel.toJson();
        catcut::TimelineModel restored;
        QString error;
        check(restored.fromJson(json, error), QStringLiteral("timeline JSON round-trip loads"),
              error);
        check(restored.primaryClips().size() == 3
                  && nearValue(restored.totalDuration(), 6.0, 1e-9),
              QStringLiteral("round-trip keeps 3 primary clips, total 6s"));
        const catcut::Transition* t = restored.transitionAfter(restored.primaryClips()[0].id);
        check(t && nearValue(t->duration, 0.5, 1e-9),
              QStringLiteral("round-trip keeps the transition"));
        check(restored.primaryClips()[0].keyframes.opacity.count() == 2,
              QStringLiteral("round-trip keeps keyframes"));
    }

    // ------------------------------------------------------- 10. render test
    {
        catcut::TimelineEvaluator evaluator(&evalModel, QSize(960, 540));
        catcut::TimelineFrameProvider provider =
            [](const QString& path, double sourceTime, QImage& out) {
                QString error;
                catcut::Decoder decoder;
                return decoder.decodeFrameAt(path, sourceTime, QSize(960, 540), out, error);
            };
        const QString pngFirst = outDir.filePath(QStringLiteral("timeline-first.png"));
        const QString pngMid = outDir.filePath(QStringLiteral("timeline-transition.png"));
        QImage firstImage, midImage;
        QString renderError;
        const bool firstOk = [&]() {
            const catcut::FrameScene scene = evaluator.evaluate(0.5);
            return catcut::TimelineFrameRenderer::render(scene, provider, firstImage,
                                                         renderError, QSize(960, 540));
        }();
        check(firstOk, QStringLiteral("timeline render first frame"), renderError);
        if (firstOk) {
            check(firstImage.save(pngFirst, "PNG"), QStringLiteral("first-frame PNG written"));
            check(firstImage.width() == 960 && firstImage.height() == 540,
                  QStringLiteral("first-frame PNG is 960x540"),
                  QStringLiteral("%1x%2").arg(firstImage.width()).arg(firstImage.height()));
            const int nonBlack = catcut::PreviewRenderer::countNonBlackPixels(firstImage, 16);
            check(nonBlack > (960 * 540) / 100, QStringLiteral("first-frame PNG is not black"),
                  QStringLiteral("non-black=%1").arg(nonBlack));
        }
        const bool midOk = [&]() {
            const catcut::FrameScene scene = evaluator.evaluate(2.0);
            return catcut::TimelineFrameRenderer::render(scene, provider, midImage,
                                                         renderError, QSize(960, 540));
        }();
        check(midOk, QStringLiteral("timeline render mid-transition frame"), renderError);
        if (midOk) {
            check(midImage.save(pngMid, "PNG"), QStringLiteral("mid-transition PNG written"));
            check(midImage.width() == 960 && midImage.height() == 540,
                  QStringLiteral("mid-transition PNG is 960x540"));
            const int nonBlack = catcut::PreviewRenderer::countNonBlackPixels(midImage, 16);
            check(nonBlack > (960 * 540) / 100, QStringLiteral("mid-transition PNG is not black"),
                  QStringLiteral("non-black=%1").arg(nonBlack));
        }
        if (firstOk && midOk) {
            // The two frames must actually differ (different source
            // material + a 50% dissolve between them).
            int diffPixels = 0, sampled = 0;
            for (int y = 0; y < 540; y += 8) {
                for (int x = 0; x < 960; x += 8) {
                    ++sampled;
                    if (firstImage.pixel(x, y) != midImage.pixel(x, y))
                        ++diffPixels;
                }
            }
            check(diffPixels > sampled / 10,
                  QStringLiteral("mid-transition frame differs from first frame"),
                  QStringLiteral("diff=%1 of %2 sampled").arg(diffPixels).arg(sampled));
        }
    }

    // ---------------------------------------------------------- summary
    out << (g_failures == 0 ? "VERIFY-S2 RESULT: PASS\n"
                            : QStringLiteral("VERIFY-S2 RESULT: FAIL (%1 failures)\n").arg(g_failures));
    out.flush();
    return g_failures == 0 ? 0 : 1;
}
