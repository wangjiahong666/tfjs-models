/**
 * @license
 * Copyright 2019 Google LLC. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * =============================================================================
 */

import * as blazeface from '@tensorflow-models/blazeface';
import * as tfconv from '@tensorflow/tfjs-converter';
import * as tf from '@tensorflow/tfjs-core';

import {Box, createBox, cutBoxFromImageAndResize, disposeBox, enlargeBox, getBoxSize, scaleBox} from './box';

// The blazeface model predictions containing unnormalized coordinates
// for facial bounding box / landmarks.
type BlazeFacePrediction = {
  box: Box,
  landmarks: tf.Tensor2D,
  probability: tf.Tensor1D,
  anchor: tf.Tensor2D|[number, number]
};

const LANDMARKS_COUNT = 468;

export class BlazePipeline {
  private blazeface: blazeface.BlazeFaceModel;
  private blazemesh: tfconv.GraphModel;
  private meshWidth: number;
  private meshHeight: number;
  private maxContinuousChecks: number;
  private runsWithoutFaceDetector: number;
  private rois: Box[];
  private maxFaces: number;

  constructor(
      blazeface: blazeface.BlazeFaceModel, blazemesh: tfconv.GraphModel,
      meshWidth: number, meshHeight: number, maxContinuousChecks: number,
      maxFaces: number) {
    this.blazeface = blazeface;
    this.blazemesh = blazemesh;
    this.meshWidth = meshWidth;
    this.meshHeight = meshHeight;
    this.maxContinuousChecks = maxContinuousChecks;
    this.runsWithoutFaceDetector = 0;
    this.rois = [];
    this.maxFaces = maxFaces;
  }

  /**
   * Calculates face mesh for specific image (468 points).
   *
   * @param {tf.Tensor!} image - image tensor of shape [1, H, W, 3].
   * @return {tf.Tensor?} tensor of 2d coordinates (1, 468, 2)
   */
  async predict(image: tf.Tensor4D):
      Promise<Array<[tf.Tensor2D, tf.Tensor2D, Box, tf.Tensor2D]>> {
    if (this.needsRoisUpdate()) {
      const returnTensors = false;
      const [blazeFacePredictions, scaleFactor] =
          await this.blazeface.getBoundingBoxes(
              image as tf.Tensor4D, returnTensors);

      if (!blazeFacePredictions.length) {
        this.clearROIs();
        return null;
      }

      const boxes = tf.tidy(
          () => blazeFacePredictions.map(
              (prediction: BlazeFacePrediction): Box => enlargeBox(
                  scaleBox(prediction.box, scaleFactor as [number, number]))));

      this.updateRoisFromFaceDetector(boxes);
      this.runsWithoutFaceDetector = 0;
    } else {
      this.runsWithoutFaceDetector++;
    }

    return tf.tidy(() => this.rois.map((roi, i) => {
      const box = roi as Box;
      const face = cutBoxFromImageAndResize(box, image, [
                     this.meshHeight, this.meshWidth
                   ]).div(255);
      const [coords, flag] =
          this.blazemesh.predict(face) as [tf.Tensor, tf.Tensor2D];

      const coords2d =
          tf.reshape(coords, [-1, 3]).slice([0, 0], [-1, 2]) as tf.Tensor2D;
      const coords2dScaled =
          tf.mul(
                coords2d,
                tf.div(getBoxSize(box), [this.meshWidth, this.meshHeight]))
              .add(box.startPoint) as tf.Tensor2D;

      const landmarksBox = this.calculateLandmarksBoundingBox(coords2dScaled);
      const prev = this.rois[i];
      if (prev) {
        disposeBox(prev);
      }
      this.rois[i] = landmarksBox;

      return [coords2d, coords2dScaled, landmarksBox, flag];
    }) as any);
  }

  updateRoisFromFaceDetector(boxes: Array<Box>) {
    for (let i = 0; i < boxes.length; i++) {
      const box = boxes[i];
      const prev = this.rois[i];
      let iou = 0;

      if (prev && prev.startPoint) {
        const boxStartEnd = box.startEndTensor.arraySync()[0];
        const prevStartEnd = prev.startEndTensor.arraySync()[0];

        const xBox = Math.max(boxStartEnd[0], prevStartEnd[0]);
        const yBox = Math.max(boxStartEnd[1], prevStartEnd[1]);
        const xPrev = Math.min(boxStartEnd[2], prevStartEnd[2]);
        const yPrev = Math.min(boxStartEnd[3], prevStartEnd[3]);

        const interArea = (xPrev - xBox) * (yPrev - yBox);

        const boxArea = (boxStartEnd[2] - boxStartEnd[0]) *
            (boxStartEnd[3] - boxStartEnd[1]);
        const prevArea = (prevStartEnd[2] - prevStartEnd[0]) *
            (prevStartEnd[3] - boxStartEnd[1]);
        iou = interArea / (boxArea + prevArea - interArea);
      }

      if (iou > 0.25) {
        this.rois[i] = prev;
      } else {
        this.rois[i] = box;
      }
    }

    for (let i = boxes.length; i < this.rois.length; i++) {
      const roi = this.rois[i];
      if (roi) {
        disposeBox(roi);
      }
    }

    this.rois = this.rois.slice(0, boxes.length);
  }

  clearROIs() {
    this.rois = [];
  }

  needsRoisUpdate(): boolean {
    const roisCount = this.rois.length;
    const noROIs = roisCount === 0;
    const shouldCheckForMoreFaces = roisCount !== this.maxFaces &&
        this.runsWithoutFaceDetector >= this.maxContinuousChecks;

    return noROIs || shouldCheckForMoreFaces;
  }

  calculateLandmarksBoundingBox(landmarks: tf.Tensor): Box {
    const xs = landmarks.slice([0, 0], [LANDMARKS_COUNT, 1]);
    const ys = landmarks.slice([0, 1], [LANDMARKS_COUNT, 1]);

    const boxMinMax = tf.stack([xs.min(), ys.min(), xs.max(), ys.max()]);
    const box = createBox(boxMinMax.expandDims(0));
    return enlargeBox(box);
  }
}
