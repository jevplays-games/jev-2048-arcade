export function fakeResponse(request, score=3) {
  return {model:request.model,answers:Object.fromEntries(Object.entries(request.questions).map(([key,q])=>[key,
    {type:'score',score,confidence:1,legend:Object.fromEntries(q.criteria.map((c,i)=>[String(i),c])),
      probabilities:Object.fromEntries(q.criteria.map((_,i)=>[String(i),i===score?1:0]))}])),
    usage:{input_tokens:512,output_tokens:64}};
}
