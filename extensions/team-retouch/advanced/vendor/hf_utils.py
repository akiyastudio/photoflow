import numpy as np 
from transformers.models.deformable_detr.modeling_deformable_detr import DeformableDetrMLPPredictionHead
import torch.nn as nn
import torch
def PairDetr(model, num_queries, num_classes):
    in_features = model.class_embed[0].in_features        
    model.model.query_position_embeddings = nn.Embedding(num_queries, 512)
    class_embed = nn.Linear(in_features, num_classes)
    bbox_embed = DeformableDetrMLPPredictionHead(
        input_dim=256, hidden_dim=256, output_dim=8, num_layers=3
    )
    model.class_embed = nn.ModuleList([class_embed for _ in range(6)])
    model.bbox_embed  = nn.ModuleList([bbox_embed for _ in range(6)])
    return model
    
def inverse_sigmoid(x, eps=1e-5):
    x = x.clamp(min=0, max=1)
    x1 = x.clamp(min=eps)
    x2 = (1 - x).clamp(min=eps)
    return torch.log(x1 / x2)
    
def forward(model,
        pixel_values,
        pixel_mask=None,
        decoder_attention_mask=None,
        encoder_outputs=None,
        inputs_embeds=None,
        decoder_inputs_embeds=None,
        labels=None,
        output_attentions=None,
        output_hidden_states=None,
        return_dict=None,) -> torch.Tensor:
        return_dict = return_dict if return_dict is not None else model.config.use_return_dict

        outputs = model.model(
            pixel_values,
            pixel_mask=pixel_mask,
            decoder_attention_mask=decoder_attention_mask,
            encoder_outputs=encoder_outputs,
            inputs_embeds=inputs_embeds,
            decoder_inputs_embeds=decoder_inputs_embeds,
            output_attentions=output_attentions,
            output_hidden_states=output_hidden_states,
            return_dict=return_dict,
        )

        hidden_states = outputs.intermediate_hidden_states if return_dict else outputs[2]
        init_reference = outputs.init_reference_points if return_dict else outputs[0]
        inter_references = outputs.intermediate_reference_points if return_dict else outputs[3]
        outputs_classes = []
        outputs_coords = []
        cons = inverse_sigmoid(init_reference)
        for level in range(hidden_states.shape[1]):
            if level == 0:
                reference = init_reference
            else:
                reference = inter_references[:, level - 1]
            reference = inverse_sigmoid(reference)
            outputs_class = model.class_embed[level](hidden_states[:, level])
            delta_bbox = model.bbox_embed[level](hidden_states[:, level])
            if reference.shape[-1] == 4:
                delta_bbox[..., :4] += reference
                outputs_coord_logits = delta_bbox
            elif reference.shape[-1] == 2:
                delta_bbox[..., :2] += reference
                delta_bbox[..., 4:6] += cons
                outputs_coord_logits = delta_bbox
            else:
                raise ValueError(f"reference.shape[-1] should be 4 or 2, but got {reference.shape[-1]}")
            outputs_coord = outputs_coord_logits.sigmoid()
            outputs_classes.append(outputs_class)
            outputs_coords.append(outputs_coord)
        outputs_class = torch.stack(outputs_classes, dim=1)
        outputs_coord = torch.stack(outputs_coords, dim=1)

        logits = outputs_class[:, -1]
        pred_boxes = outputs_coord[:, -1]

        dict_outputs = {
            "logits":logits,
            "pred_boxes": pred_boxes,
            "init_reference_points": outputs.init_reference_points,
                       }    
        return dict_outputs
